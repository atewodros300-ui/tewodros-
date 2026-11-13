from __future__ import annotations

import argparse
import getpass
import ipaddress
import logging
import os
import random
import re
import signal
import sys
import threading
import time
import traceback
import urllib.parse
import warnings
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

import requests
from requests.auth import AuthBase, HTTPBasicAuth, HTTPDigestAuth


DEVICE_INFO_PATH = "/ISAPI/System/deviceInfo"
STREAM_CHANNELS_PATH = "/ISAPI/Streaming/channels"
STREAM_INDEX = {"main": 1, "sub": 2}
RETRY_BASE_SECONDS = 1.0
RETRY_MAX_SECONDS = 30.0
RETRY_JITTER_SECONDS = 0.35
HEALTHY_RESET_SECONDS = 60.0

_URL_CREDENTIALS = re.compile(
    r"(?i)\b((?:rtsp|rtsps|https?)://)([^:/@\s]+):([^@\s]*)@"
)


@dataclass
class Config:
    host: str
    username: str
    password: str
    http_port: int
    https: bool
    insecure: bool
    rtsp_port: int
    stream: str
    channel: Optional[int]
    tcp: bool
    timeout: float
    max_retries: int
    stall_timeout: float
    snapshot_dir: Path
    list_only: bool
    skip_discovery: bool
    strict: bool
    verbose: bool


@dataclass
class DeviceInfo:
    device_name: str = "n/a"
    model: str = "n/a"
    firmware_version: str = "n/a"
    serial_number: str = "n/a"


@dataclass
class ChannelInfo:
    channel_id: Optional[int]
    channel_name: str
    codec: str
    resolution: str
    frame_rate: str
    bitrate: str
    bitrate_mode: str

    @property
    def logical_channel(self) -> Optional[int]:
        if self.channel_id is None:
            return None
        if self.channel_id >= 100:
            return self.channel_id // 100
        return self.channel_id

    @property
    def stream_index(self) -> Optional[int]:
        if self.channel_id is None or self.channel_id < 100:
            return None
        return self.channel_id % 100


@dataclass
class FrameState:
    frame: Optional[Any]
    updated_at: float
    fps: float
    stream: str
    channel_id: int
    status: str
    notice: str


@dataclass
class OpenedStream:
    capture: Any
    first_frame: Any
    candidate_index: int
    channel_id: int


class CameraError(Exception):
    exit_code = 1


class AuthenticationError(CameraError):
    exit_code = 2


class PermissionError(CameraError):
    exit_code = 2


class NetworkError(CameraError):
    exit_code = 3


class IsapiUnsupported(CameraError):
    exit_code = 4


class StreamError(CameraError):
    exit_code = 5


class SecretRedactingFilter(logging.Filter):
    """Redact URL user-info even if a lower-level library logs an exception."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            record.msg = redact_credentials(record.getMessage())
            record.args = ()
            if record.exc_info:
                record.exc_text = redact_credentials(
                    "".join(traceback.format_exception(*record.exc_info))
                )
                record.exc_info = None
        except Exception:
            record.msg = "[log message redacted]"
            record.args = ()
        return True


def redact_credentials(value: str) -> str:
    return _URL_CREDENTIALS.sub(
        lambda match: "{}{}:****@".format(match.group(1), match.group(2)),
        value,
    )


def mask_url(url: str) -> str:
    """Return a URL suitable for logs and --list output."""
    return redact_credentials(url)


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].split(":")[-1]


def _find_text(element: ET.Element, names: Sequence[str]) -> Optional[str]:
    desired = {name.lower() for name in names}
    for node in element.iter():
        if local_name(node.tag).lower() in desired and node.text:
            value = node.text.strip()
            if value:
                return value
    return None


def _display(value: Optional[str]) -> str:
    return value if value else "n/a"


def parse_device_info(xml_data: bytes) -> DeviceInfo:
    """Parse deviceInfo XML without assuming a namespace."""
    root = ET.fromstring(xml_data)
    return DeviceInfo(
        device_name=_display(_find_text(root, ("deviceName",))),
        model=_display(_find_text(root, ("model",))),
        firmware_version=_display(_find_text(root, ("firmwareVersion",))),
        serial_number=_display(_find_text(root, ("serialNumber",))),
    )


def _frame_rate(raw_value: Optional[str]) -> str:
    if not raw_value:
        return "n/a"
    try:
        value = float(raw_value)
    except ValueError:
        return "n/a"
    # Hikvision commonly reports hundredths of an fps (2500 = 25 fps);
    # values below 1000 are treated as whole fps for firmware variants.
    fps = value / 100.0 if value >= 1000 else value
    if fps <= 0 or fps > 240:
        return "n/a"
    return "{} fps".format(int(fps) if fps.is_integer() else round(fps, 2))


def parse_channels(xml_data: bytes) -> List[ChannelInfo]:
    """Parse a channel list or a single StreamingChannel element."""
    root = ET.fromstring(xml_data)
    nodes = [
        node for node in root.iter()
        if local_name(node.tag).lower() == "streamingchannel"
    ]
    channels: List[ChannelInfo] = []
    for node in nodes:
        raw_id = _find_text(node, ("id",))
        try:
            channel_id = int(raw_id) if raw_id else None
        except ValueError:
            channel_id = None

        width = _find_text(node, ("videoResolutionWidth",))
        height = _find_text(node, ("videoResolutionHeight",))
        resolution = "{}x{}".format(width, height) if width and height else "n/a"

        mode = (_find_text(node, ("bitrateType",)) or "").upper()
        cbr = _find_text(node, ("constantBitRate",))
        vbr = _find_text(node, ("vbrUpperCap",))
        if mode == "CBR" and cbr:
            bitrate, bitrate_mode = cbr, "CBR"
        elif mode == "VBR" and vbr:
            bitrate, bitrate_mode = vbr, "VBR"
        elif cbr:
            bitrate, bitrate_mode = cbr, "CBR"
        elif vbr:
            bitrate, bitrate_mode = vbr, "VBR"
        else:
            bitrate, bitrate_mode = "n/a", "n/a"

        channels.append(ChannelInfo(
            channel_id=channel_id,
            channel_name=_display(_find_text(node, ("channelName",))),
            codec=_display(_find_text(node, ("videoCodecType",))),
            resolution=resolution,
            frame_rate=_frame_rate(_find_text(node, ("maxFrameRate",))),
            bitrate=bitrate,
            bitrate_mode=bitrate_mode,
        ))

    return sorted(
        channels,
        key=lambda channel: (
            channel.channel_id is None,
            channel.channel_id if channel.channel_id is not None else 0,
        ),
    )


def stream_channel_id(channel: int, stream: str) -> int:
    if channel < 1:
        raise ValueError("channel must be at least 1")
    if stream not in STREAM_INDEX:
        raise ValueError("stream must be 'main' or 'sub'")
    return channel * 100 + STREAM_INDEX[stream]


def select_channel_id(
    channels: Sequence[ChannelInfo],
    channel: int,
    stream: str,
) -> Optional[int]:
    desired_index = STREAM_INDEX[stream]
    for item in channels:
        if item.channel_id is None:
            continue
        if item.logical_channel == channel and item.stream_index == desired_index:
            return item.channel_id
    return None


def _url_host(host: str) -> str:
    address = host.strip()
    if address.startswith("[") and address.endswith("]"):
        address = address[1:-1]
    if ":" in address:
        address = re.sub(r"%(?!25)", "%25", address, flags=re.IGNORECASE)
        return "[{}]".format(address)
    return address


def build_rtsp_urls(
    host: str,
    port: int,
    username: str,
    password: str,
    channel: int,
    stream: str,
    discovered_id: Optional[int] = None,
) -> List[str]:
    """Build the documented URL candidates without doing network I/O."""
    channel_id = discovered_id if discovered_id is not None else stream_channel_id(channel, stream)
    user = urllib.parse.quote(username, safe="")
    secret = urllib.parse.quote(password, safe="")
    authority = "{}:{}@{}:{}".format(user, secret, _url_host(host), port)
    legacy = "main" if stream == "main" else "sub"
    return [
        "rtsp://{}/Streaming/Channels/{}".format(authority, channel_id),
        "rtsp://{}/ISAPI/Streaming/channels/{}".format(authority, channel_id),
        "rtsp://{}/h264/ch{}/{}/av_stream".format(authority, channel, legacy),
    ]


def _valid_port(value: str) -> int:
    try:
        port = int(value)
    except (TypeError, ValueError):
        raise argparse.ArgumentTypeError("port must be an integer from 1 to 65535")
    if not 1 <= port <= 65535:
        raise argparse.ArgumentTypeError("port must be from 1 to 65535")
    return port


def _positive_int(value: str) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise argparse.ArgumentTypeError("value must be a positive integer")
    if number < 1:
        raise argparse.ArgumentTypeError("value must be at least 1")
    return number


def _nonnegative_int(value: str) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise argparse.ArgumentTypeError("value must be a non-negative integer")
    if number < 0:
        raise argparse.ArgumentTypeError("value must be 0 or greater")
    return number


def _positive_float(value: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise argparse.ArgumentTypeError("value must be a positive number")
    if number <= 0:
        raise argparse.ArgumentTypeError("value must be greater than 0")
    return number


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    normalized = raw.strip().lower()
    if normalized in ("1", "true", "yes", "on"):
        return True
    if normalized in ("0", "false", "no", "off"):
        return False
    raise ValueError("{} must be true or false".format(name))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Discover a Hikvision camera/NVR stream through ISAPI and display "
            "the authorized RTSP feed in an OpenCV window."
        ),
        epilog=(
            "Examples:\n"
            "  python hik_stream.py --ip 192.168.1.64 --user viewer\n"
            "  python hik_stream.py --host camera.local --user viewer "
            "--stream sub --https --insecure\n"
            "Set HIKVISION_PASS in the environment to avoid command-line credentials."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--ip", "--host", dest="host", default=os.environ.get("HIKVISION_IP"),
                        help="camera IP/hostname (env: HIKVISION_IP)")
    parser.add_argument("--user", default=os.environ.get("HIKVISION_USER"),
                        help="camera username (env: HIKVISION_USER)")
    parser.add_argument("--password", default=None,
                        help="camera password; prefer HIKVISION_PASS environment variable")
    parser.add_argument("--http-port", type=_valid_port, default=None,
                        help="ISAPI HTTP(S) port (env: HIKVISION_HTTP_PORT)")
    parser.add_argument("--https", action="store_true", help="use HTTPS for ISAPI")
    parser.add_argument("--insecure", action="store_true",
                        help="skip HTTPS certificate verification (unsafe; for trusted LAN only)")
    parser.add_argument("--rtsp-port", type=_valid_port, default=None,
                        help="RTSP port (env: HIKVISION_RTSP_PORT; default: 554)")
    parser.add_argument("--stream", choices=("main", "sub"),
                        default=os.environ.get("HIKVISION_STREAM", "main"),
                        help="stream to open (env: HIKVISION_STREAM; default: main)")
    parser.add_argument("--channel", type=_positive_int, default=None,
                        help="logical channel N (env: HIKVISION_CHANNEL; default: lowest discovered)")
    parser.add_argument("--tcp", action=argparse.BooleanOptionalAction, default=None,
                        help="use RTSP over TCP (default: on; --no-tcp selects UDP)")
    parser.add_argument("--timeout", type=_positive_float, default=5.0,
                        help="ISAPI connect/read and capture open timeout in seconds (default: 5)")
    parser.add_argument("--max-retries", type=_nonnegative_int, default=10,
                        help="reconnect retries after first frame; 0 means unlimited (default: 10)")
    parser.add_argument("--stall-timeout", type=_positive_float, default=5.0,
                        help="reconnect after this many seconds without a frame (default: 5)")
    parser.add_argument("--snapshot-dir", type=Path, default=Path.cwd(),
                        help="directory for snapshots (default: current directory)")
    parser.add_argument("--list", action="store_true",
                        help="list camera/channel information and masked RTSP candidates, then exit")
    parser.add_argument("--skip-discovery", action="store_true",
                        help="skip ISAPI and use the standard RTSP channel id")
    parser.add_argument("--strict", action="store_true",
                        help="exit with code 4 if ISAPI is unsupported")
    parser.add_argument("-v", "--verbose", action="store_true",
                        help="enable debug logging (native FFmpeg logs remain quiet)")
    return parser


def _validate_host(host: str) -> str:
    value = host.strip()
    if not value or any(char.isspace() for char in value) or any(char in value for char in "/@?#"):
        raise ValueError("camera host must be an IP address or hostname, not a URL")
    unbracketed = value[1:-1] if value.startswith("[") and value.endswith("]") else value
    if ":" in unbracketed:
        try:
            ipaddress.ip_address(unbracketed.split("%", 1)[0])
        except ValueError:
            raise ValueError("host containing ':' must be a valid IPv6 literal")
    return unbracketed


def config_from_args(parser: argparse.ArgumentParser, args: argparse.Namespace) -> Config:
    if not args.host:
        parser.error("--ip/--host is required (or set HIKVISION_IP)")
    if not args.user:
        parser.error("--user is required (or set HIKVISION_USER)")
    try:
        host = _validate_host(args.host)
        tcp = args.tcp if args.tcp is not None else _env_bool("HIKVISION_TCP", True)
        http_env = os.environ.get("HIKVISION_HTTP_PORT")
        http_port = args.http_port if args.http_port is not None else (
            _valid_port(http_env) if http_env else (443 if args.https else 80)
        )
        rtsp_env = os.environ.get("HIKVISION_RTSP_PORT")
        rtsp_port = args.rtsp_port if args.rtsp_port is not None else (
            _valid_port(rtsp_env) if rtsp_env else 554
        )
        env_channel = os.environ.get("HIKVISION_CHANNEL")
        channel = args.channel if args.channel is not None else (
            _positive_int(env_channel) if env_channel else None
        )
    except (ValueError, argparse.ArgumentTypeError) as error:
        parser.error(str(error))

    if args.stream not in STREAM_INDEX:
        parser.error("HIKVISION_STREAM must be 'main' or 'sub'")
    if args.insecure and not args.https:
        parser.error("--insecure requires --https")
    if args.list and args.skip_discovery:
        parser.error("--list cannot be combined with --skip-discovery")

    password = args.password if args.password is not None else os.environ.get("HIKVISION_PASS")
    if not password:
        if sys.stdin.isatty():
            password = getpass.getpass("Camera password: ")
        else:
            raise CameraError(
                "Password is required; set HIKVISION_PASS or run in a terminal to be prompted."
            )
    if not password:
        raise CameraError("Camera password cannot be empty.")
    if args.password is not None:
        logging.getLogger(__name__).warning(
            "A command-line password can be visible in shell history and process lists; "
            "prefer HIKVISION_PASS."
        )

    return Config(
        host=host,
        username=args.user,
        password=password,
        http_port=http_port,
        https=args.https,
        insecure=args.insecure,
        rtsp_port=rtsp_port,
        stream=args.stream,
        channel=channel,
        tcp=tcp,
        timeout=args.timeout,
        max_retries=args.max_retries,
        stall_timeout=args.stall_timeout,
        snapshot_dir=args.snapshot_dir,
        list_only=args.list,
        skip_discovery=args.skip_discovery,
        strict=args.strict,
        verbose=args.verbose,
    )


def configure_logging(verbose: bool) -> logging.Logger:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    redactor = SecretRedactingFilter()
    root = logging.getLogger()
    for handler in root.handlers:
        handler.addFilter(redactor)
    return logging.getLogger("hik_stream")


def configure_opencv_environment(tcp: bool, verbose: bool) -> None:
    if tcp:
        os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = (
            "rtsp_transport;tcp|fflags;nobuffer|flags;low_delay"
        )
    else:
        os.environ.pop("OPENCV_FFMPEG_CAPTURE_OPTIONS", None)
    os.environ["OPENCV_LOG_LEVEL"] = "ERROR" if verbose else "SILENT"
    # FFmpeg's own diagnostics can echo the RTSP URL; keep them quiet in all modes.
    os.environ["OPENCV_FFMPEG_LOGLEVEL"] = "-8"


def _http_base(config: Config) -> str:
    scheme = "https" if config.https else "http"
    return "{}://{}:{}".format(scheme, _url_host(config.host), config.http_port)


def _request(
    session: requests.Session,
    url: str,
    config: Config,
    auth: Optional[AuthBase] = None,
) -> requests.Response:
    try:
        return session.get(
            url,
            auth=auth,
            timeout=(config.timeout, config.timeout),
            verify=not config.insecure,
            allow_redirects=False,
        )
    except requests.exceptions.SSLError:
        raise NetworkError(
            "TLS error. Check the HTTPS port/certificate; for a trusted self-signed "
            "camera certificate, use --https --insecure."
        ) from None
    except requests.exceptions.Timeout:
        raise NetworkError(
            "ISAPI request timed out; host may be unreachable. Check IP, network, and firewall."
        ) from None
    except requests.exceptions.ConnectionError as error:
        message = str(error).lower()
        if "refused" in message:
            raise NetworkError(
                "Connection refused; check the HTTP port or whether the camera web service is enabled."
            ) from None
        raise NetworkError(
            "Could not reach the camera. Check IP, network, firewall, and HTTP port."
        ) from None
    except requests.exceptions.RequestException:
        raise NetworkError("ISAPI network request failed.") from None


def _check_http_status(response: requests.Response, endpoint: str) -> None:
    status = response.status_code
    if status == 401:
        raise AuthenticationError(
            "401 Unauthorized. Check credentials and whether the account is temporarily locked; "
            "authentication failed without retrying."
        )
    if status == 403:
        raise PermissionError(
            "403 Forbidden. The camera account may lack remote-access or live-view permission."
        )
    if status in (404, 405, 501):
        raise IsapiUnsupported(
            "{} returned HTTP {}. ISAPI may be disabled or unsupported on this firmware.".format(
                endpoint, status
            )
        )
    if status >= 500:
        raise NetworkError(
            "{} returned HTTP {}; check camera health and firmware.".format(endpoint, status)
        )
    if status < 200 or status >= 300:
        raise IsapiUnsupported(
            "{} returned unexpected HTTP status {}.".format(endpoint, status)
        )


def _response_xml(response: requests.Response, endpoint: str) -> ET.Element:
    _check_http_status(response, endpoint)
    body = response.content
    content_type = response.headers.get("Content-Type", "").lower()
    prefix = body.lstrip()[:100].lower()
    if not body or "text/html" in content_type or prefix.startswith(b"<!doctype html") or prefix.startswith(b"<html"):
        raise IsapiUnsupported(
            "{} did not return XML; ISAPI may be disabled or the device returned a web page.".format(
                endpoint
            )
        )
    try:
        root = ET.fromstring(body)
    except ET.ParseError:
        raise IsapiUnsupported(
            "{} returned a non-XML or invalid XML response.".format(endpoint)
        ) from None
    if local_name(root.tag).lower() in ("html", "body"):
        raise IsapiUnsupported(
            "{} returned an HTML page instead of ISAPI XML.".format(endpoint)
        )

    if local_name(root.tag).lower() == "responsestatus":
        code = _find_text(root, ("statusCode",))
        if code and code not in ("1", "200", "OK"):
            message = _find_text(root, ("statusString",)) or "camera rejected the ISAPI request"
            raise IsapiUnsupported("{}: {}.".format(endpoint, message))
    return root


def _auth_for_challenge(header: str) -> Optional[str]:
    lowered = header.lower()
    if "digest" in lowered:
        return "digest"
    if "basic" in lowered:
        return "basic"
    return None


def _make_auth(scheme: str, config: Config) -> AuthBase:
    if scheme == "digest":
        return HTTPDigestAuth(config.username, config.password)
    return HTTPBasicAuth(config.username, config.password)


def _authenticate_401(
    session: requests.Session,
    config: Config,
    logger: logging.Logger,
    url: str,
    endpoint: str,
    response: requests.Response,
) -> Tuple[AuthBase, requests.Response]:
    challenge = response.headers.get("WWW-Authenticate", "")
    selected = _auth_for_challenge(challenge)
    if selected is not None:
        auth = _make_auth(selected, config)
        retry = _request(session, url, config, auth)
        _check_http_status(retry, endpoint)
        logger.info("Camera requested %s authentication.", selected.title())
        if selected == "basic" and not config.https:
            logger.warning("Basic authentication over HTTP is not encrypted; use HTTPS or a trusted isolated network.")
        return auth, retry

    # Some firmware omits WWW-Authenticate. Try each scheme at most once.
    for scheme in ("digest", "basic"):
        auth = _make_auth(scheme, config)
        retry = _request(session, url, config, auth)
        if retry.status_code == 401:
            continue
        _check_http_status(retry, endpoint)
        logger.info("Selected %s authentication (challenge header was absent).", scheme.title())
        if scheme == "basic" and not config.https:
            logger.warning("Basic authentication over HTTP is not encrypted; use HTTPS or a trusted isolated network.")
        return auth, retry

    raise AuthenticationError(
        "401 Unauthorized. Check the camera username/password and whether the account is locked."
    )


def _choose_auth(
    session: requests.Session,
    config: Config,
    logger: logging.Logger,
) -> Tuple[Optional[AuthBase], requests.Response]:
    url = _http_base(config) + DEVICE_INFO_PATH
    response = _request(session, url, config)
    if response.status_code == 401:
        return _authenticate_401(
            session, config, logger, url, DEVICE_INFO_PATH, response
        )
    _check_http_status(response, DEVICE_INFO_PATH)
    return None, response


def discover_device(
    session: requests.Session,
    config: Config,
    logger: logging.Logger,
) -> Tuple[DeviceInfo, List[ChannelInfo], Optional[str]]:
    auth, info_response = _choose_auth(session, config, logger)
    info_root = _response_xml(info_response, DEVICE_INFO_PATH)
    info = DeviceInfo(
        device_name=_display(_find_text(info_root, ("deviceName",))),
        model=_display(_find_text(info_root, ("model",))),
        firmware_version=_display(_find_text(info_root, ("firmwareVersion",))),
        serial_number=_display(_find_text(info_root, ("serialNumber",))),
    )

    url = _http_base(config) + STREAM_CHANNELS_PATH
    response = _request(session, url, config, auth)
    if response.status_code == 401 and auth is None:
        auth, response = _authenticate_401(
            session, config, logger, url, STREAM_CHANNELS_PATH, response
        )
    try:
        root = _response_xml(response, STREAM_CHANNELS_PATH)
    except IsapiUnsupported as error:
        return info, [], str(error)
    channels = parse_channels(ET.tostring(root, encoding="utf-8"))
    if not channels:
        return info, [], "ISAPI returned no StreamingChannel entries."
    return info, channels, None


def _print_device_info(info: DeviceInfo) -> None:
    print("Device name:      {}".format(info.device_name))
    print("Model:            {}".format(info.model))
    print("Firmware version: {}".format(info.firmware_version))
    print("Serial number:    {}".format(info.serial_number))


def print_channel_table(channels: Sequence[ChannelInfo]) -> None:
    headers = ("ID", "CHANNEL NAME", "CODEC", "RESOLUTION", "FRAME RATE", "BITRATE")
    rows = [
        (
            str(item.channel_id) if item.channel_id is not None else "n/a",
            item.channel_name,
            item.codec,
            item.resolution,
            item.frame_rate,
            "{} {} kbps".format(item.bitrate_mode, item.bitrate)
            if item.bitrate != "n/a" else "n/a",
        )
        for item in channels
    ]
    widths = [
        max(len(headers[index]), *(len(row[index]) for row in rows)) if rows
        else len(headers[index])
        for index in range(len(headers))
    ]
    print("  ".join(headers[index].ljust(widths[index]) for index in range(len(headers))))
    print("  ".join("-" * width for width in widths))
    for row in rows:
        print("  ".join(row[index].ljust(widths[index]) for index in range(len(headers))))
    if not rows:
        print("(no channels discovered)")


def _channel_name(channels: Sequence[ChannelInfo], channel: int) -> Optional[str]:
    for item in channels:
        if item.logical_channel == channel and item.channel_name != "n/a":
            return item.channel_name
    return None


def _candidate_urls(
    config: Config,
    channel: int,
    stream: str,
    channels: Sequence[ChannelInfo],
    logger: logging.Logger,
    warn_if_missing: bool = True,
) -> Tuple[List[str], int]:
    discovered_id = select_channel_id(channels, channel, stream)
    synthesized_id = stream_channel_id(channel, stream)
    if channels and discovered_id is None:
        log = logger.warning if warn_if_missing else logger.debug
        log(
            "Channel %s %s-stream id %s was not discovered; using the standard id.",
            channel, stream, synthesized_id,
        )
    urls = build_rtsp_urls(
        config.host, config.rtsp_port, config.username, config.password,
        channel, stream, discovered_id,
    )
    return urls, discovered_id if discovered_id is not None else synthesized_id


def _safe_ascii(value: str) -> str:
    return value.encode("ascii", "replace").decode("ascii")


def _slug(value: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9._-]+", "_", _safe_ascii(value)).strip("._-")
    return slug or "camera"


def _set_text(
    cv2: Any,
    frame: Any,
    text: str,
    origin: Tuple[int, int],
    scale: float = 0.55,
) -> None:
    safe_text = _safe_ascii(text)
    cv2.putText(frame, safe_text, origin, cv2.FONT_HERSHEY_SIMPLEX, scale, (0, 0, 0), 4, cv2.LINE_AA)
    cv2.putText(frame, safe_text, origin, cv2.FONT_HERSHEY_SIMPLEX, scale, (245, 248, 252), 1, cv2.LINE_AA)


def _open_capture(cv2: Any, url: str, timeout: float) -> Optional[Any]:
    params: List[int] = []
    open_prop = getattr(cv2, "CAP_PROP_OPEN_TIMEOUT_MSEC", None)
    read_prop = getattr(cv2, "CAP_PROP_READ_TIMEOUT_MSEC", None)
    if open_prop is not None and read_prop is not None:
        millis = max(1, int(timeout * 1000))
        params = [open_prop, millis, read_prop, millis]
    try:
        if params:
            capture = cv2.VideoCapture(url, cv2.CAP_FFMPEG, params)
        else:
            capture = cv2.VideoCapture(url, cv2.CAP_FFMPEG)
    except Exception:
        # Older OpenCV builds may not accept timeout parameters in the constructor.
        try:
            capture = cv2.VideoCapture(url, cv2.CAP_FFMPEG)
        except Exception:
            return None
    try:
        if not capture.isOpened():
            capture.release()
            return None
    except Exception:
        try:
            capture.release()
        except Exception:
            pass
        return None
    try:
        capture.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    except Exception:
        pass
    return capture


class CaptureWorker:
    """Owns VideoCapture and publishes only the newest frame to the UI thread."""

    def __init__(
        self,
        cv2: Any,
        plans: Dict[str, Tuple[List[str], int]],
        config: Config,
        logger: logging.Logger,
    ) -> None:
        self._cv2 = cv2
        self._plans = plans
        self._config = config
        self._logger = logger
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._initial_ready = threading.Event()
        self._requested_stream: Optional[str] = None
        self._active_stream = config.stream
        self._status = "CONNECTING"
        self._notice = ""
        self._notice_until = 0.0
        self._frame: Optional[Any] = None
        self._updated_at = 0.0
        self._fps = 0.0
        self._previous_frame_at = 0.0
        self._channel_id = self._plans[config.stream][1]
        self._candidate_indexes: Dict[str, int] = {}
        self._initial_failed = False
        self._thread = threading.Thread(target=self._safe_run, name="hikvision-frame-reader", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def wait_initial(self, timeout: float) -> bool:
        return self._initial_ready.wait(timeout)

    @property
    def initial_failed(self) -> bool:
        with self._lock:
            return self._initial_failed

    def request_switch(self) -> Optional[str]:
        with self._lock:
            if self._requested_stream is not None:
                return None
            target = "sub" if self._active_stream == "main" else "main"
            self._requested_stream = target
            return target

    def snapshot(self) -> FrameState:
        with self._lock:
            notice = self._notice if time.monotonic() < self._notice_until else ""
            return FrameState(
                frame=self._frame,
                updated_at=self._updated_at,
                fps=self._fps,
                stream=self._active_stream,
                channel_id=self._channel_id,
                status=self._status,
                notice=notice,
            )

    def stop(self) -> None:
        self._stop.set()

    def join(self, timeout: float) -> None:
        if self._thread.ident is None:
            return
        self._thread.join(timeout)
        if self._thread.is_alive():
            self._logger.warning("Capture reader is still stopping; it is a daemon thread.")

    def _publish_frame(self, frame: Any) -> None:
        now = time.monotonic()
        with self._lock:
            if self._previous_frame_at:
                instant_fps = 1.0 / max(0.001, now - self._previous_frame_at)
                self._fps = instant_fps if self._fps == 0 else (0.85 * self._fps + 0.15 * instant_fps)
            self._previous_frame_at = now
            self._updated_at = now
            self._frame = frame

    def _set_status(self, status: str) -> None:
        with self._lock:
            self._status = status

    def _set_notice(self, message: str, seconds: float = 5.0) -> None:
        with self._lock:
            self._notice = message
            self._notice_until = time.monotonic() + seconds

    def _take_switch_request(self) -> Optional[str]:
        with self._lock:
            requested = self._requested_stream
            self._requested_stream = None
            return requested

    def _connect(self, stream: str) -> Optional[OpenedStream]:
        urls, default_channel_id = self._plans[stream]
        preferred = self._candidate_indexes.get(stream)
        order = list(range(len(urls)))
        if preferred is not None and preferred in order:
            order.remove(preferred)
            order.insert(0, preferred)

        for candidate_index in order:
            if self._stop.is_set():
                return None
            url = urls[candidate_index]
            self._logger.info("Opening RTSP candidate %s", mask_url(url))
            capture = _open_capture(self._cv2, url, self._config.timeout)
            if capture is None:
                self._logger.debug("OpenCV could not open this candidate.")
                continue

            deadline = time.monotonic() + self._config.stall_timeout
            while not self._stop.is_set() and time.monotonic() < deadline:
                try:
                    ok, frame = capture.read()
                except Exception:
                    ok, frame = False, None
                if ok and frame is not None:
                    channel_id = self._plans[stream][1] or default_channel_id
                    self._candidate_indexes[stream] = candidate_index
                    return OpenedStream(capture, frame, candidate_index, channel_id)
                self._stop.wait(0.05)

            try:
                capture.release()
            except Exception:
                pass
            self._logger.debug("Candidate produced no frame before the stall timeout.")
        return None

    def _switch_stream(self, capture: Any, requested: str) -> Tuple[Optional[Any], str]:
        previous = self._active_stream
        if capture is not None:
            try:
                capture.release()
            except Exception:
                pass
        self._set_status("SWITCHING TO {}".format(requested.upper()))

        opened = self._connect(requested)
        if opened is not None:
            self._publish_frame(opened.first_frame)
            with self._lock:
                self._active_stream = requested
                self._channel_id = opened.channel_id
                self._status = "LIVE"
            self._set_notice("Switched to {} stream".format(requested))
            return opened.capture, requested

        self._logger.warning("Could not open %s stream; restoring %s.", requested, previous)
        self._set_status("RESTORING {}".format(previous.upper()))
        restored = self._connect(previous)
        if restored is not None:
            self._publish_frame(restored.first_frame)
            with self._lock:
                self._active_stream = previous
                self._channel_id = restored.channel_id
                self._status = "LIVE"
            self._set_notice(
                "{} stream unavailable; restored {}".format(requested.title(), previous)
            )
            return restored.capture, previous

        self._set_notice("Stream switch failed; reconnecting {}".format(previous), 8.0)
        self._set_status("RECONNECTING")
        return None, previous

    def _safe_run(self) -> None:
        try:
            self._run()
        except Exception as error:
            self._logger.error("Capture worker failed: %s", error)
            with self._lock:
                self._initial_failed = not self._initial_ready.is_set()
                self._status = "STREAM ERROR"
            self._initial_ready.set()

    def _run(self) -> None:
        active = self._active_stream
        opened = self._connect(active)
        if opened is None:
            with self._lock:
                self._initial_failed = True
                self._status = "UNABLE TO OPEN STREAM"
            self._initial_ready.set()
            return

        capture: Optional[Any] = opened.capture
        self._channel_id = opened.channel_id
        self._publish_frame(opened.first_frame)
        self._set_status("LIVE")
        self._initial_ready.set()
        healthy_since = time.monotonic()
        last_frame = healthy_since
        retries = 0

        while not self._stop.is_set():
            requested = self._take_switch_request()
            if requested is not None:
                capture, active = self._switch_stream(capture, requested)
                if capture is not None:
                    last_frame = time.monotonic()
                    healthy_since = last_frame
                    retries = 0
                else:
                    last_frame = 0.0
                continue

            if capture is None:
                retries += 1
                if self._config.max_retries and retries > self._config.max_retries:
                    self._set_status("STREAM LOST")
                    self._logger.error("Reconnect limit reached; press q to close.")
                    return
                retry_label = (
                    "unlimited" if self._config.max_retries == 0
                    else str(self._config.max_retries)
                )
                self._set_status("RECONNECTING {}/{}".format(retries, retry_label))
                delay = min(RETRY_MAX_SECONDS, RETRY_BASE_SECONDS * (2 ** min(retries - 1, 8)))
                delay += random.uniform(0.0, RETRY_JITTER_SECONDS)
                if self._stop.wait(delay):
                    break
                opened = self._connect(active)
                if opened is None:
                    continue
                capture = opened.capture
                self._channel_id = opened.channel_id
                self._publish_frame(opened.first_frame)
                now = time.monotonic()
                if now - healthy_since >= HEALTHY_RESET_SECONDS:
                    retries = 0
                healthy_since = now
                last_frame = now
                self._set_status("LIVE")
                continue

            try:
                ok, frame = capture.read()
            except Exception:
                ok, frame = False, None
            if ok and frame is not None:
                self._publish_frame(frame)
                last_frame = time.monotonic()
                if last_frame - healthy_since >= HEALTHY_RESET_SECONDS:
                    retries = 0
                    healthy_since = last_frame
                self._set_status("LIVE")
                continue

            if time.monotonic() - last_frame >= self._config.stall_timeout:
                try:
                    capture.release()
                except Exception:
                    pass
                capture = None
                self._logger.warning("No new frame before stall timeout; reconnecting.")
            else:
                self._stop.wait(0.03)

        if capture is not None:
            try:
                capture.release()
            except Exception:
                pass


def _window_title(camera_name: str, stream: str) -> str:
    return "{} - {} stream".format(_safe_ascii(camera_name), stream.title())


def _draw_overlay(cv2: Any, frame: Any, state: FrameState) -> Any:
    height, width = frame.shape[:2]
    overlay_height = 66 if state.notice else 46
    cv2.rectangle(frame, (0, 0), (width, overlay_height), (19, 28, 43), -1)
    first = "{}  |  {} fps  |  {}x{}".format(
        state.status,
        "{:.1f}".format(state.fps),
        width,
        height,
    )
    second = "Channel {}  |  {} stream".format(state.channel_id, state.stream)
    _set_text(cv2, frame, first, (12, 19), 0.48)
    _set_text(cv2, frame, second, (12, 39), 0.43)
    if state.notice:
        _set_text(cv2, frame, state.notice, (12, 59), 0.4)
    return frame


def _save_snapshot(
    cv2: Any,
    frame: Any,
    directory: Path,
    camera_name: str,
    stream: str,
    logger: logging.Logger,
) -> None:
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = "snapshot_{}_{}_{}.jpg".format(_slug(camera_name), stream, timestamp)
    path = directory / filename
    try:
        directory.mkdir(parents=True, exist_ok=True)
        saved = bool(cv2.imwrite(str(path), frame))
    except Exception:
        saved = False
    if saved:
        logger.info("Snapshot saved: %s", path)
    else:
        logger.error("Could not save snapshot to %s.", path)


def show_stream(
    cv2: Any,
    worker: CaptureWorker,
    config: Config,
    camera_name: str,
    logger: logging.Logger,
    shutdown: threading.Event,
) -> None:
    state = worker.snapshot()
    title = _window_title(camera_name, state.stream)
    cv2.namedWindow(title, cv2.WINDOW_NORMAL)
    active_stream = state.stream
    last_frame: Optional[Any] = None

    while not shutdown.is_set():
        state = worker.snapshot()
        if state.stream != active_stream:
            try:
                cv2.destroyWindow(title)
            except Exception:
                pass
            active_stream = state.stream
            title = _window_title(camera_name, active_stream)
            cv2.namedWindow(title, cv2.WINDOW_NORMAL)

        if state.frame is not None:
            last_frame = state.frame
            display = state.frame.copy()
            cv2.imshow(title, _draw_overlay(cv2, display, state))

        key = cv2.waitKey(20) & 0xFF
        if key in (ord("q"), 27):
            shutdown.set()
            break
        if key == ord("m"):
            target = worker.request_switch()
            if target is None:
                logger.info("A stream switch is already in progress.")
            else:
                logger.info("Switching to %s stream.", target)
        if key == ord("s"):
            if last_frame is None or time.monotonic() - state.updated_at > config.stall_timeout:
                logger.warning("No fresh frame is available to save.")
            else:
                _save_snapshot(
                    cv2, last_frame, config.snapshot_dir, camera_name, active_stream, logger
                )

        try:
            if cv2.getWindowProperty(title, cv2.WND_PROP_VISIBLE) < 1:
                shutdown.set()
        except Exception:
            shutdown.set()


def _print_candidate_urls(urls: Sequence[str]) -> None:
    for index, url in enumerate(urls, 1):
        print("  {}. {}".format(index, mask_url(url)))


def _select_channel(channels: Sequence[ChannelInfo], requested: Optional[int]) -> int:
    if requested is not None:
        return requested
    numbers = sorted({
        item.logical_channel for item in channels if item.logical_channel is not None
    })
    return numbers[0] if numbers else 1


def _make_http_session(config: Config) -> requests.Session:
    session = requests.Session()
    session.headers.update({"User-Agent": "hik-stream-viewer/1.0"})
    if config.insecure:
        from requests.packages.urllib3.exceptions import InsecureRequestWarning

        warnings.filterwarnings("ignore", category=InsecureRequestWarning)
    return session


def _run_main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    logger = configure_logging(args.verbose)
    try:
        config = config_from_args(parser, args)
    except CameraError as error:
        logger.error("%s", error)
        return error.exit_code

    if config.insecure:
        logger.warning(
            "TLS certificate verification is disabled. Use only on a trusted network."
        )

    device_info = DeviceInfo()
    channels: List[ChannelInfo] = []
    unsupported_reason: Optional[str] = None
    if config.skip_discovery:
        logger.info("ISAPI discovery skipped; using a standard RTSP channel id.")
    else:
        session = _make_http_session(config)
        try:
            device_info, channels, unsupported_reason = discover_device(
                session, config, logger
            )
        except IsapiUnsupported as error:
            unsupported_reason = str(error)
        except CameraError as error:
            logger.error("%s", error)
            return error.exit_code
        finally:
            session.close()

        if unsupported_reason:
            if config.strict:
                logger.error("%s", unsupported_reason)
                return IsapiUnsupported.exit_code
            logger.warning(
                "%s Continuing in RTSP-only mode.", unsupported_reason
            )

        if device_info.device_name != "n/a":
            logger.info(
                "Camera: %s | model: %s | firmware: %s | serial: %s",
                device_info.device_name,
                device_info.model,
                device_info.firmware_version,
                device_info.serial_number,
            )

    channel = _select_channel(channels, config.channel)
    channel_name = _channel_name(channels, channel)
    camera_name = (
        device_info.device_name
        if device_info.device_name != "n/a"
        else (channel_name or config.host)
    )
    plans: Dict[str, Tuple[List[str], int]] = {}
    for stream in ("main", "sub"):
        urls, channel_id = _candidate_urls(
            config,
            channel,
            stream,
            channels,
            logger,
            warn_if_missing=(stream == config.stream),
        )
        plans[stream] = (urls, channel_id)

    if config.list_only:
        _print_device_info(device_info)
        print_channel_table(channels)
        print("\nSelected logical channel: {} ({})".format(
            channel, channel_name or "name unavailable"
        ))
        print("Masked {} stream candidates:".format(config.stream))
        _print_candidate_urls(plans[config.stream][0])
        return 0

    if not config.https and not config.skip_discovery:
        logger.warning(
            "ISAPI HTTP is not encrypted. Prefer HTTPS or a trusted isolated network."
        )
    logger.warning(
        "RTSP streams are not encrypted by this viewer; use only a trusted isolated network or VPN."
    )

    configure_opencv_environment(config.tcp, config.verbose)
    try:
        import cv2
    except ImportError:
        logger.error(
            "OpenCV is required. Install dependencies with: python -m pip install -r requirements.txt"
        )
        return 1

    shutdown = threading.Event()
    interrupted = threading.Event()

    def request_shutdown(signum: int, frame: Any) -> None:
        if signum == signal.SIGINT:
            interrupted.set()
        shutdown.set()

    previous_handlers: Dict[int, Any] = {}
    for sig in (signal.SIGINT, getattr(signal, "SIGTERM", signal.SIGINT)):
        try:
            previous_handlers[sig] = signal.getsignal(sig)
            signal.signal(sig, request_shutdown)
        except (ValueError, OSError):
            pass

    worker = CaptureWorker(cv2, plans, config, logger)
    try:
        worker.start()
        startup_wait = max(
            15.0,
            (config.timeout + config.stall_timeout + 1.0) * 3.0,
        )
        if not worker.wait_initial(startup_wait):
            logger.error(
                "Initial stream connection timed out. Check credentials, stream id, "
                "RTSP service, and network access."
            )
            return StreamError.exit_code
        if worker.initial_failed:
            logger.error(
                "No RTSP candidate produced a frame. Check RTSP access, channel id, "
                "credentials, and live-view permission; refusing repeated initial retries."
            )
            return StreamError.exit_code

        logger.info(
            "Connected to authorized camera stream. Press q/Esc to quit, s to save a snapshot, "
            "m to switch main/sub."
        )
        show_stream(cv2, worker, config, camera_name, logger, shutdown)
        return 130 if interrupted.is_set() else 0
    except KeyboardInterrupt:
        return 130
    except CameraError as error:
        logger.error("%s", error)
        return error.exit_code
    except Exception as error:
        logger.error("Unexpected error: %s", error)
        return 1
    finally:
        shutdown.set()
        worker.stop()
        worker.join(max(2.0, config.timeout + 1.0))
        try:
            cv2.destroyAllWindows()
        except Exception:
            pass
        for sig, old_handler in previous_handlers.items():
            try:
                signal.signal(sig, old_handler)
            except (ValueError, OSError):
                pass


def main(argv: Optional[Sequence[str]] = None) -> int:
    try:
        return _run_main(argv)
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
