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

// TLS for every connection to the server: https:// requests (through lwIP's
// httpc) and the wss:// socket (WsClient). Connections come from an
// altcp allocator that wraps TCP in mbedTLS, sends the server's name (SNI)
// and checks its certificate chain against the built-in roots
// (certs/roots.pem) and its name against that name. Nothing falls back to
// plain TCP.

#pragma once

#include <cstddef>

#include "lwip/altcp.h"
#include "lwip/apps/http_client.h"

// An altcp allocator function: a TLS connection that only completes its
// handshake with a server that proves it is `host` (a const char *, which
// must outlive the connection). Called with lwIP's lock held, as httpc and
// WsClient do.
struct altcp_pcb *tls_new_connection(void *host, u8_t ip_type);

// For httpc_connection_t::altcp_allocator and WsClient: TLS connections to
// SERVER_HOST
altcp_allocator_t *server_tls_allocator();

// Keeps the TLS session of an established connection so the next connection
// can resume it, skipping the certificate checks and key exchange. Call once
// the connection is up (its first data, or WsClient's on_open).
void tls_remember_session(struct altcp_pcb *conn);

// An httpc_connection_t::headers_done_fn that remembers the connection's
// session, for a request whose answer may have no body (a 204), which never
// reaches the data callback
err_t tls_remember_httpc_session(httpc_state_t *connection, void *arg, struct pbuf *hdr, u16_t hdr_len,
                                 u32_t content_len);

struct TlsMemory
{
    // Bytes mbedTLS has allocated now, and at most since boot
    std::size_t tls_now;
    std::size_t tls_peak;
    // The whole heap (malloc): in use now, at most (sampled whenever mbedTLS
    // allocates) and its size
    std::size_t heap_now;
    std::size_t heap_peak;
    std::size_t heap_size;
};

TlsMemory tls_memory();

// Prints tls_memory() as "TLS: heap ..."
void tls_log_memory();
