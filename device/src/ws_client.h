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

#pragma once

// A WebSocket client on lwIP's raw TCP API: DNS, connect, the upgrade
// handshake, then framed messages both ways. The framing and handshake live
// in ws_frame and ws_handshake (host tested); this file only moves bytes.
//
// Everything runs in lwIP's callbacks, so the listener is called with the
// lwIP lock held: it must be quick and must not block. The public methods
// take the lock themselves (it's recursive, so the listener may call them),
// except abort(), and close() before the socket is open: those free the
// connection the callback is still using, so call them from outside.

#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

#include "lwip/altcp.h"
#include "lwip/ip_addr.h"
#include "ws_frame.h"

class WsClient : private ws::FrameSink
{
  public:
    class Listener
    {
      public:
        virtual ~Listener() = default;
        // The server accepted the upgrade
        virtual void on_open() = 0;
        // A complete text or binary message
        virtual void on_message(ws::Opcode opcode, const uint8_t *data, std::size_t length) = 0;
        // The connection ended or never got going: once per connect() that
        // returned true, unless abort() ended it
        virtual void on_closed() = 0;
    };

    // Messages are assembled in `buffer`; a bigger one fails the connection
    WsClient(uint8_t *buffer, std::size_t capacity, Listener &listener);

    WsClient(const WsClient &) = delete;
    WsClient &operator=(const WsClient &) = delete;

    // Starts connecting to ws://host:port/target. Returns false (with no
    // on_closed() to follow) if it can't start, or a connection is already
    // under way.
    bool connect(const char *host, uint16_t port, std::string_view target);

    // Queues a message. Returns false unless the socket is open.
    bool send(ws::Opcode opcode, const uint8_t *data, std::size_t length);
    bool send_text(std::string_view text);

    // Starts the closing handshake; on_closed() follows
    void close(uint16_t code = ws::CLOSE_NORMAL);

    // Drops the connection at once, with no on_closed()
    void abort();

    bool is_open() const
    {
        return state_ == State::OPEN;
    }

    bool is_idle() const
    {
        return state_ == State::IDLE;
    }

  private:
    enum class State : uint8_t
    {
        IDLE,
        RESOLVING,
        CONNECTING,
        HANDSHAKE,
        OPEN,
        // A close frame was sent; waiting for the server to close the TCP
        // connection
        CLOSING,
    };

    // lwIP callbacks
    static void on_dns(const char *name, const ip_addr_t *address, void *arg);
    static err_t on_connected(void *arg, struct altcp_pcb *pcb, err_t err);
    static err_t on_recv(void *arg, struct altcp_pcb *pcb, struct pbuf *p, err_t err);
    static err_t on_sent(void *arg, struct altcp_pcb *pcb, u16_t length);
    static err_t on_poll(void *arg, struct altcp_pcb *pcb);
    static void on_err(void *arg, err_t err);

    // FrameSink
    void on_message(ws::Opcode opcode, const uint8_t *data, std::size_t length) override;
    void on_ping(const uint8_t *data, std::size_t length) override;
    void on_pong(const uint8_t *data, std::size_t length) override;
    void on_close(uint16_t code, const uint8_t *reason, std::size_t length) override;
    void on_error(uint16_t close_code) override;

    void start_tcp(const ip_addr_t &address);
    void receive(const uint8_t *data, std::size_t length);
    void receive_handshake(const uint8_t *data, std::size_t length);
    void queue_frame(ws::Opcode opcode, const uint8_t *data, std::size_t length);
    void start_closing(uint16_t code);
    bool flush();
    void clear_tx();
    // Ends the connection (closing or aborting the pcb) and tells the
    // listener. Returns ERR_ABRT if it aborted the pcb.
    err_t finish(bool abort_pcb);
    void detach();

    Listener &listener_;
    ws::FrameDecoder decoder_;

    State state_ = State::IDLE;
    struct altcp_pcb *pcb_ = nullptr;
    uint16_t port_ = 0;
    std::string host_;
    std::string target_;
    std::string key_;
    std::string head_;
    bool close_sent_ = false;
    // A protocol error or bad handshake asked for the pcb to be dropped
    bool abort_requested_ = false;
    uint32_t closing_deadline_ms_ = 0;

    std::vector<uint8_t> tx_;
    std::size_t tx_written_ = 0;
};
