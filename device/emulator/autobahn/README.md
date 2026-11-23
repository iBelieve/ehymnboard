# Autobahn test suite for the firmware's WebSocket client

The board's WebSocket client (`device/src/ws_client.cpp` and the pure
`ws_frame`/`ws_handshake` code under it) is checked against the
[Autobahn test suite](https://github.com/crossbario/autobahn-testsuite)'s
fuzzingserver, running the real firmware code in the emulator.

`ehymnboard_autobahn` is a separate firmware build (`src/autobahn_main.cpp`)
with the same client: it asks the fuzzingserver how many cases there are, runs
each one as the suite's echo client (every message it gets goes back
unchanged, in a 65 KB buffer), then asks for the report. The emulator sends
every connection the board makes to the fuzzingserver, byte for byte, holding
the simulated clock while the server answers.

Sections 1 to 7 run: framing, pings and pongs, reserved bits, opcodes,
fragmentation, UTF-8 and the closing handshake. Sections 9 (performance, with
messages up to 16 MB), 10 (auto-fragmentation), 12 and 13 (compression) don't
apply: the board's messages are short text, and it doesn't offer
permessage-deflate.

```sh
# from device/, after building (the ehymnboard_autobahn target is part of the build)
docker run -d --rm --name autobahn -p 9001:80 \
  -v "$PWD/emulator/autobahn/fuzzingserver.json:/config/fuzzingserver.json:ro" \
  -v "$PWD/emulator/autobahn/reports:/reports" \
  crossbario/autobahn-testsuite@sha256:519915fb568b04c9383f70a1c405ae3ff44ab9e35835b085239c258b6fac3074 \
  wstest -m fuzzingserver -s /config/fuzzingserver.json
cd emulator && node autobahn/run.ts
docker stop autobahn
```

The fuzzingserver listens on port 80 inside the container because it checks
the `Host` header's port, and the board connects to `autobahn.test` on port 80.
The run takes about 30 s and fails unless every case is OK, NON-STRICT or
INFORMATIONAL (the suite's passing verdicts). The HTML report is in
`autobahn/reports/clients/index.html`.
