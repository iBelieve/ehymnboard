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

#include "ws_client.h"

#include <algorithm>
#include <array>
#include <cstdio>

#include "lwip/altcp_tcp.h"
#include "lwip/dns.h"
#include "lwip/pbuf.h"
#include "lwip/tcp.h"
#include "pico/cyw43_arch.h"
#include "pico/rand.h"
#include "pico/time.h"
#include "tls.h"
#include "ws_handshake.h"

// A server's response head is a few hundred bytes; anything bigger isn't one
static constexpr std::size_t MAX_RESPONSE_HEAD = 2048;
// How long to wait for the server to close the TCP connection after a close
// frame
static constexpr uint32_t CLOSING_TIMEOUT_MS = 3000;
// Send buffer capacity kept between messages; anything bigger is freed
static constexpr std::size_t TX_KEEP_CAPACITY = 1024;
// on_poll runs every this many half seconds
static constexpr u8_t POLL_INTERVAL = 2;

static uint32_t now_ms()
{
    return to_ms_since_boot(get_absolute_time());
}

static std::array<uint8_t, 4> random_mask()
{
    const uint32_t r = get_rand_32();
    return {static_cast<uint8_t>(r), static_cast<uint8_t>(r >> 8U), static_cast<uint8_t>(r >> 16U),
            static_cast<uint8_t>(r >> 24U)};
}

WsClient::WsClient(uint8_t *buffer, std::size_t capacity, Listener &listener)
    : listener_(listener), decoder_(buffer, capacity)
{
}

bool WsClient::connect(const char *host, uint16_t port, std::string_view target, altcp_allocator_t *tls)
{
    cyw43_arch_lwip_begin();

    if (state_ != State::IDLE)
    {
        cyw43_arch_lwip_end();
        return false;
    }

    host_ = host;
    port_ = port;
    tls_ = tls;
    target_ = std::string(target);
    head_.clear();
    clear_tx();
    close_sent_ = false;
    abort_requested_ = false;
    decoder_.reset();

    std::array<uint8_t, 16> random{};
    for (std::size_t i = 0; i < random.size(); i += 4)
    {
        const uint32_t r = get_rand_32();
        std::copy_n(reinterpret_cast<const uint8_t *>(&r), 4, random.begin() + static_cast<std::ptrdiff_t>(i));
    }
    key_ = ws::make_key(random);

    state_ = State::RESOLVING;
    ip_addr_t address;
    const err_t err = dns_gethostbyname(host_.c_str(), &address, on_dns, this);

    bool started = true;
    if (err == ERR_OK)
    {
        start_tcp(address);
        // start_tcp reports its own failures through on_closed()
    }
    else if (err != ERR_INPROGRESS)
    {
        printf("WS: DNS lookup of %s failed to start: %d\n", host_.c_str(), err);
        state_ = State::IDLE;
        started = false;
    }

    cyw43_arch_lwip_end();
    return started;
}

void WsClient::on_dns([[maybe_unused]] const char *name, const ip_addr_t *address, void *arg)
{
    auto *self = static_cast<WsClient *>(arg);
    if (self->state_ != State::RESOLVING)
    {
        // Aborted while resolving
        return;
    }
    if (address == nullptr)
    {
        printf("WS: DNS lookup of %s failed\n", self->host_.c_str());
        self->finish(false);
        return;
    }
    self->start_tcp(*address);
}

void WsClient::start_tcp(const ip_addr_t &address)
{
    pcb_ =
        tls_ != nullptr ? altcp_new_ip_type(tls_, IP_GET_TYPE(&address)) : altcp_tcp_new_ip_type(IP_GET_TYPE(&address));
    if (pcb_ == nullptr)
    {
        printf("WS: out of memory for a connection\n");
        finish(false);
        return;
    }

    altcp_arg(pcb_, this);
    altcp_recv(pcb_, on_recv);
    altcp_sent(pcb_, on_sent);
    altcp_err(pcb_, on_err);
    altcp_poll(pcb_, on_poll, POLL_INTERVAL);

    state_ = State::CONNECTING;
    const err_t err = altcp_connect(pcb_, &address, port_, on_connected);
    if (err != ERR_OK)
    {
        printf("WS: connect failed to start: %d\n", err);
        finish(true);
    }
}

err_t WsClient::on_connected(void *arg, [[maybe_unused]] struct altcp_pcb *pcb, err_t err)
{
    auto *self = static_cast<WsClient *>(arg);
    if (err != ERR_OK)
    {
        return self->finish(true);
    }

    // Over TLS, this runs once the TLS handshake is done
    if (self->tls_ != nullptr)
    {
        tls_remember_session(self->pcb_);
    }

    self->state_ = State::HANDSHAKE;
    const auto request = ws::build_upgrade_request(self->host_, self->port_, self->tls_ != nullptr, self->target_,
                                                   self->key_, HTTPC_CLIENT_AGENT);
    self->tx_.insert(self->tx_.end(), request.begin(), request.end());
    if (!self->flush())
    {
        return self->finish(true);
    }
    return ERR_OK;
}

err_t WsClient::on_recv(void *arg, struct altcp_pcb *pcb, struct pbuf *p, err_t err)
{
    auto *self = static_cast<WsClient *>(arg);

    if (p == nullptr || err != ERR_OK)
    {
        // The server closed the connection
        if (p != nullptr)
        {
            pbuf_free(p);
        }
        return self->finish(false);
    }

    for (const struct pbuf *q = p; q != nullptr && !self->abort_requested_; q = q->next)
    {
        self->receive(static_cast<const uint8_t *>(q->payload), q->len);
    }
    altcp_recved(pcb, p->tot_len);
    pbuf_free(p);

    if (self->abort_requested_)
    {
        return self->finish(true);
    }
    if (!self->flush())
    {
        return self->finish(true);
    }
    return ERR_OK;
}

void WsClient::receive(const uint8_t *data, std::size_t length)
{
    if (state_ == State::HANDSHAKE)
    {
        receive_handshake(data, length);
        return;
    }
    if (state_ == State::OPEN || state_ == State::CLOSING)
    {
        decoder_.feed(data, length, *this);
    }
}

void WsClient::receive_handshake(const uint8_t *data, std::size_t length)
{
    const auto before = head_.size();
    head_.append(reinterpret_cast<const char *>(data), length);

    const auto end = head_.find("\r\n\r\n");
    if (end == std::string::npos)
    {
        if (head_.size() > MAX_RESPONSE_HEAD)
        {
            printf("WS: response head too long\n");
            abort_requested_ = true;
        }
        return;
    }

    const auto head_length = end + 4;
    const auto result = ws::check_upgrade_response(std::string_view(head_).substr(0, head_length), key_);
    if (result != ws::HandshakeResult::OK)
    {
        printf("WS: upgrade refused (status %d, result %d)\n", ws::response_status(head_), static_cast<int>(result));
        abort_requested_ = true;
        return;
    }

    state_ = State::OPEN;
    listener_.on_open();

    // Frames that arrived in the same segment as the head
    const auto used = head_length - before;
    head_.clear();
    head_.shrink_to_fit();
    if (state_ == State::OPEN && used < length)
    {
        decoder_.feed(data + used, length - used, *this);
    }
}

err_t WsClient::on_sent(void *arg, [[maybe_unused]] struct altcp_pcb *pcb, [[maybe_unused]] u16_t length)
{
    auto *self = static_cast<WsClient *>(arg);
    if (!self->flush())
    {
        return self->finish(true);
    }
    return ERR_OK;
}

err_t WsClient::on_poll(void *arg, [[maybe_unused]] struct altcp_pcb *pcb)
{
    auto *self = static_cast<WsClient *>(arg);
    if (self->abort_requested_)
    {
        return self->finish(true);
    }
    if (self->state_ == State::CLOSING && static_cast<int32_t>(now_ms() - self->closing_deadline_ms_) >= 0)
    {
        printf("WS: server didn't close the connection, dropping it\n");
        return self->finish(true);
    }
    if (!self->flush())
    {
        return self->finish(true);
    }
    return ERR_OK;
}

void WsClient::on_err(void *arg, err_t err)
{
    // lwIP has already freed the pcb
    auto *self = static_cast<WsClient *>(arg);
    printf("WS: connection error %d\n", err);
    self->pcb_ = nullptr;
    self->finish(false);
}

// --- Frames ------------------------------------------------------------------

void WsClient::on_message(ws::Opcode opcode, const uint8_t *data, std::size_t length)
{
    if (state_ == State::OPEN)
    {
        listener_.on_message(opcode, data, length);
    }
}

void WsClient::on_ping(const uint8_t *data, std::size_t length)
{
    if (state_ == State::OPEN)
    {
        queue_frame(ws::Opcode::PONG, data, length);
    }
}

void WsClient::on_pong([[maybe_unused]] const uint8_t *data, [[maybe_unused]] std::size_t length)
{
    // We ping with "ping" text messages, which the server's auto-response
    // answers without waking up; unsolicited pongs are allowed and ignored
}

void WsClient::on_close(uint16_t code, [[maybe_unused]] const uint8_t *reason, [[maybe_unused]] std::size_t length)
{
    printf("WS: server closed the socket (%u)\n", code);
    // Echo the code back, then wait for the server to close the TCP connection
    start_closing(code);
}

void WsClient::on_error(uint16_t close_code)
{
    printf("WS: protocol error, closing with %u\n", close_code);
    start_closing(close_code);
}

void WsClient::queue_frame(ws::Opcode opcode, const uint8_t *data, std::size_t length)
{
    ws::encode_frame(tx_, opcode, data, length, random_mask());
}

void WsClient::start_closing(uint16_t code)
{
    if (!close_sent_)
    {
        close_sent_ = true;
        ws::encode_close(tx_, code, random_mask());
    }
    if (state_ != State::CLOSING)
    {
        state_ = State::CLOSING;
        closing_deadline_ms_ = now_ms() + CLOSING_TIMEOUT_MS;
    }
}

bool WsClient::flush()
{
    if (pcb_ == nullptr)
    {
        return true;
    }

    while (tx_written_ < tx_.size())
    {
        const auto room = static_cast<std::size_t>(altcp_sndbuf(pcb_));
        // A segment at a time: each write is copied into lwIP's small heap
        // (MEM_SIZE), which can't take a whole send buffer at once
        const auto chunk = std::min<std::size_t>({room, tx_.size() - tx_written_, TCP_MSS});
        if (chunk == 0)
        {
            break;
        }
        const err_t err = altcp_write(pcb_, tx_.data() + tx_written_, static_cast<u16_t>(chunk), TCP_WRITE_FLAG_COPY);
        if (err == ERR_MEM)
        {
            // Out of queue space for now; on_sent or on_poll tries again
            break;
        }
        if (err != ERR_OK)
        {
            printf("WS: write failed: %d\n", err);
            return false;
        }
        tx_written_ += chunk;
    }

    if (tx_written_ == tx_.size())
    {
        clear_tx();
    }

    return altcp_output(pcb_) == ERR_OK;
}

// --- Public ------------------------------------------------------------------

bool WsClient::send(ws::Opcode opcode, const uint8_t *data, std::size_t length)
{
    cyw43_arch_lwip_begin();
    bool sent = false;
    if (state_ == State::OPEN)
    {
        queue_frame(opcode, data, length);
        sent = true;
        if (!flush())
        {
            // Dropped on the next lwIP callback: this may be running inside
            // one, where the pcb can't be freed yet
            abort_requested_ = true;
        }
    }
    cyw43_arch_lwip_end();
    return sent;
}

bool WsClient::send_text(std::string_view text)
{
    return send(ws::Opcode::TEXT, reinterpret_cast<const uint8_t *>(text.data()), text.size());
}

void WsClient::close(uint16_t code)
{
    cyw43_arch_lwip_begin();
    if (state_ == State::OPEN)
    {
        start_closing(code);
        flush();
    }
    else if (state_ != State::IDLE && state_ != State::CLOSING)
    {
        // Not open yet: nothing to close politely
        finish(true);
    }
    cyw43_arch_lwip_end();
}

void WsClient::abort()
{
    cyw43_arch_lwip_begin();
    if (pcb_ != nullptr)
    {
        detach();
        altcp_abort(pcb_);
        pcb_ = nullptr;
    }
    state_ = State::IDLE;
    cyw43_arch_lwip_end();
}

void WsClient::clear_tx()
{
    // Hand a big buffer back to the heap: the next big message would
    // otherwise need room for both while the vector grows
    if (tx_.capacity() > TX_KEEP_CAPACITY)
    {
        std::vector<uint8_t>().swap(tx_);
    }
    tx_.clear();
    tx_written_ = 0;
}

void WsClient::detach()
{
    altcp_arg(pcb_, nullptr);
    altcp_recv(pcb_, nullptr);
    altcp_sent(pcb_, nullptr);
    altcp_err(pcb_, nullptr);
    altcp_poll(pcb_, nullptr, 0);
}

err_t WsClient::finish(bool abort_pcb)
{
    err_t result = ERR_OK;
    if (pcb_ != nullptr)
    {
        detach();
        if (abort_pcb || altcp_close(pcb_) != ERR_OK)
        {
            altcp_abort(pcb_);
            result = ERR_ABRT;
        }
        pcb_ = nullptr;
    }

    const bool was_connecting = state_ != State::IDLE;
    state_ = State::IDLE;
    clear_tx();
    if (was_connecting)
    {
        listener_.on_closed();
    }
    return result;
}
