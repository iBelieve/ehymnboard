/*
 * eHymnBoard device firmware
 * Copyright (C) 2026  Michael Spencer <sonrisesoftware@gmail.com>

 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.

 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.

 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

// A test build (the ehymnboard_autobahn target) that runs WsClient against
// the Autobahn test suite's fuzzingserver, as the suite's echo client: it asks
// the server how many cases there are, runs each one by echoing back every
// message it gets, then asks the server to write its report. The emulator runs
// it (see emulator/autobahn/), ending the board's TLS (port 443) and passing
// the plain bytes on to the fuzzingserver; it isn't meant for a real board.

#include <cstdio>
#include <cstdlib>
#include <string>

#include "pico/cyw43_arch.h"
#include "pico/stdlib.h"
#include "tls.h"
#include "wifi.h"
#include "ws_client.h"

#ifndef AUTOBAHN_HOST
#define AUTOBAHN_HOST "autobahn.test"
#endif
#ifndef AUTOBAHN_PORT
#define AUTOBAHN_PORT 443
#endif

// wss://, as the real firmware connects: the emulator's TLS server has a
// test certificate for this name (device/certs/test)
static altcp_allocator_t tls = {
    tls_new_connection,
    const_cast<char *>(AUTOBAHN_HOST), // NOLINT(cppcoreguidelines-pro-type-const-cast): only ever read
};

static constexpr const char *AGENT = "ehymnboard";

// The suite's biggest messages in sections 1-7 are 64 KiB
static constexpr std::size_t MESSAGE_BUFFER_SIZE = 65536 + 1024;
static uint8_t message_buffer[MESSAGE_BUFFER_SIZE];

namespace
{

class EchoListener : public WsClient::Listener
{
  public:
    void on_open() override
    {
    }

    void on_message(ws::Opcode opcode, const uint8_t *data, std::size_t length) override
    {
        if (echo && client != nullptr)
        {
            client->send(opcode, data, length);
        }
        else
        {
            last_text.assign(reinterpret_cast<const char *>(data), length);
        }
    }

    void on_closed([[maybe_unused]] const SocketEndInfo &end) override
    {
        closed = true;
    }

    WsClient *client = nullptr;
    bool echo = false;
    bool closed = false;
    std::string last_text;
};

EchoListener listener;
WsClient client(message_buffer, sizeof(message_buffer), listener);

} // namespace

// Connects to `target` and waits for the connection to end
static bool run(const std::string &target, bool echo)
{
    listener.echo = echo;
    listener.closed = false;
    if (!client.connect(AUTOBAHN_HOST, AUTOBAHN_PORT, target, &tls))
    {
        printf("AUTOBAHN: couldn't connect for %s\n", target.c_str());
        return false;
    }
    while (!listener.closed)
    {
        sleep_ms(10);
    }
    return true;
}

int main()
{
    stdio_init_all();
    listener.client = &client;

    setup_wifi();

    if (!run("/getCaseCount", false))
    {
        printf("AUTOBAHN FAILED\n");
        return 1;
    }
    const int cases = static_cast<int>(std::strtol(listener.last_text.c_str(), nullptr, 10));
    printf("AUTOBAHN: %d cases\n", cases);

    for (int i = 1; i <= cases; i++)
    {
        printf("AUTOBAHN: case %d of %d\n", i, cases);
        run("/runCase?case=" + std::to_string(i) + "&agent=" + AGENT, true);
    }

    run(std::string("/updateReports?agent=") + AGENT, false);
    printf("AUTOBAHN DONE\n");

    while (true)
    {
        sleep_ms(1000);
    }
}
