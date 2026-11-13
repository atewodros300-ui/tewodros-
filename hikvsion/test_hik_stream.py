from __future__ import annotations

import unittest
from contextlib import redirect_stdout
from io import StringIO
import logging

try:
    from .hik_stream import (
        SecretRedactingFilter,
        build_parser,
        build_rtsp_urls,
        mask_url,
        parse_channels,
        parse_device_info,
        select_channel_id,
        stream_channel_id,
    )
except ImportError:
    from hik_stream import (
        SecretRedactingFilter,
        build_parser,
        build_rtsp_urls,
        mask_url,
        parse_channels,
        parse_device_info,
        select_channel_id,
        stream_channel_id,
    )


DEVICE_XML = b"""\
<DeviceInfo xmlns="http://www.hikvision.com/ver20/XMLSchema">
  <deviceName>Lobby Camera</deviceName><model>DS-2CD</model>
  <firmwareVersion>V5.7</firmwareVersion><serialNumber>TEST-SERIAL</serialNumber>
</DeviceInfo>"""

CHANNELS_XML = b"""\
<StreamingChannelList xmlns="http://www.isapi.org/ver20/XMLSchema">
  <StreamingChannel><id>101</id><channelName>Entrance</channelName>
    <Video><videoCodecType>H.265</videoCodecType><videoResolutionWidth>1920</videoResolutionWidth>
      <videoResolutionHeight>1080</videoResolutionHeight><maxFrameRate>2500</maxFrameRate>
      <bitrateType>CBR</bitrateType><constantBitRate>4096</constantBitRate>
    </Video>
  </StreamingChannel>
  <StreamingChannel><id>102</id><channelName>Entrance sub</channelName>
    <videoCodecType>H.264</videoCodecType><videoResolutionWidth>640</videoResolutionWidth>
    <videoResolutionHeight>360</videoResolutionHeight><maxFrameRate>25</maxFrameRate>
    <bitrateType>VBR</bitrateType><vbrUpperCap>512</vbrUpperCap>
  </StreamingChannel>
</StreamingChannelList>"""

SINGLE_CHANNEL_XML = b"""\
<StreamingChannel><id>201</id><channelName>North</channelName>
  <videoCodecType>H.264</videoCodecType><videoResolutionWidth>1280</videoResolutionWidth>
  <videoResolutionHeight>720</videoResolutionHeight><maxFrameRate>3000</maxFrameRate>
</StreamingChannel>"""


class HikStreamParserTests(unittest.TestCase):
    def test_device_info_is_parsed_namespace_agnostically(self) -> None:
        info = parse_device_info(DEVICE_XML)
        self.assertEqual(info.device_name, "Lobby Camera")
        self.assertEqual(info.model, "DS-2CD")
        self.assertEqual(info.serial_number, "TEST-SERIAL")

    def test_channel_list_supports_namespaces_and_bitrate_modes(self) -> None:
        channels = parse_channels(CHANNELS_XML)
        self.assertEqual([item.channel_id for item in channels], [101, 102])
        self.assertEqual(channels[0].resolution, "1920x1080")
        self.assertEqual(channels[0].frame_rate, "25 fps")
        self.assertEqual(channels[0].bitrate_mode, "CBR")
        self.assertEqual(channels[1].bitrate_mode, "VBR")
        self.assertEqual(select_channel_id(channels, 1, "sub"), 102)

    def test_single_channel_without_namespace_and_missing_values(self) -> None:
        channels = parse_channels(SINGLE_CHANNEL_XML)
        self.assertEqual(len(channels), 1)
        self.assertEqual(channels[0].channel_id, 201)
        self.assertEqual(channels[0].frame_rate, "30 fps")
        self.assertEqual(channels[0].bitrate, "n/a")
        self.assertEqual(select_channel_id(channels, 2, "main"), 201)

    def test_channel_id_mapping(self) -> None:
        self.assertEqual(stream_channel_id(1, "main"), 101)
        self.assertEqual(stream_channel_id(2, "sub"), 202)
        self.assertEqual(stream_channel_id(10, "main"), 1001)

    def test_url_credentials_are_encoded_and_masked(self) -> None:
        password = "p@ss:w/rd#1"
        urls = build_rtsp_urls(
            "192.168.1.64", 554, "admin", password, 1, "main", discovered_id=101
        )
        self.assertEqual(len(urls), 3)
        self.assertIn("p%40ss%3Aw%2Frd%231", urls[0])
        self.assertNotIn(password, urls[0])
        self.assertIn("admin:****@192.168.1.64:554", mask_url(urls[0]))
        self.assertNotIn(password, mask_url(urls[0]))

    def test_logging_filter_redacts_encoded_passwords(self) -> None:
        password = "p@ss:w/rd#1"
        url = build_rtsp_urls("192.168.1.64", 554, "admin", password, 1, "main")[0]
        record = logging.LogRecord("test", logging.ERROR, "", 0, "failed: %s", (url,), None)
        SecretRedactingFilter().filter(record)
        self.assertNotIn(password, record.getMessage())
        self.assertIn("admin:****@192.168.1.64", record.getMessage())

    def test_ipv6_url_is_bracketed(self) -> None:
        urls = build_rtsp_urls("2001:db8::1", 554, "u", "p", 1, "sub")
        self.assertIn("@[2001:db8::1]:554/", urls[0])

    def test_help_does_not_need_camera_credentials(self) -> None:
        parser = build_parser()
        with redirect_stdout(StringIO()):
            with self.assertRaises(SystemExit) as result:
                parser.parse_args(["--help"])
        self.assertEqual(result.exception.code, 0)


if __name__ == "__main__":
    unittest.main()
