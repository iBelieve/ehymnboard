/*
 * eHymnBoard device firmware
 * Copyright (C) 2025-2026  Michael Spencer <sonrisesoftware@gmail.com>

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

#include "fetch_image.h"

#include <string>

#include "http_headers.h"
#include "pico/async_context.h"
#include "pico/cyw43_arch.h"
#include "request_path.h"
#include "tls.h"
#include "utils.h"

static size_t image_buffer_offset = 0;
// Everything the server sent, including anything past the end of the buffer.
static size_t image_bytes_received = 0;

namespace
{

struct FetchImageHttpRequest
{
    bool complete = false;
    httpc_result_t result = HTTPC_RESULT_ERR_UNKNOWN;
    u32_t status_code = 0;

    // Captured from the response headers; only adopted by the caller once
    // the full image body has been received.
    std::string new_etag;
};

} // namespace

static err_t on_headers_received(httpc_state_t *connection, void *arg, struct pbuf *hdr, u16_t hdr_len,
                                 u32_t content_len)
{
    assert(arg);
    FetchImageHttpRequest *req = (FetchImageHttpRequest *)arg;
    // Here rather than on the body, which a 304 doesn't have
    tls_remember_httpc_session(connection, arg, hdr, hdr_len, content_len);

    // The headers can span several pbufs (and the last can hold the start of
    // the body), so copy exactly the header block out before parsing it.
    std::string headers(hdr_len, '\0');
    headers.resize(pbuf_copy_partial(hdr, headers.data(), hdr_len, 0));

    req->new_etag = find_etag(headers);

    if (req->new_etag.empty())
    {
        printf("WARNING: Etag not found in headers\n");
    }
    else
    {
        printf("Etag: %s\n", req->new_etag.c_str());
    }

    return ERR_OK;
}

static err_t on_http_data_received([[maybe_unused]] void *arg, struct altcp_pcb *conn, struct pbuf *p,
                                   [[maybe_unused]] err_t err)
{
    assert(arg);

    const auto space_left = image_buffer.size() - image_buffer_offset;
    const auto bytes_to_copy = p->tot_len < space_left ? p->tot_len : space_left;

    // Once the buffer is full, keep accepting (and dropping) data so the
    // connection finishes; fetch_image rejects the oversized image afterwards.
    const auto bytes_copied = pbuf_copy_partial(p, image_buffer.data() + image_buffer_offset, bytes_to_copy, 0);

    image_buffer_offset += bytes_copied;
    image_bytes_received += p->tot_len;

    printf("Received %d, copied %d, total %u bytes\n", p->tot_len, bytes_copied, (unsigned)image_bytes_received);

    altcp_recved(conn, p->tot_len);
    pbuf_free(p);

    return ERR_OK;
}

static void on_http_req_completed(void *arg, httpc_result_t httpc_result, u32_t rx_content_len, u32_t srv_res,
                                  err_t err)
{
    assert(arg);
    FetchImageHttpRequest *req = (FetchImageHttpRequest *)arg;

    printf("Fetch image HTTP request completed with result: %d, content length: %lu, server "
           "response: %lu, error: %d\n",
           httpc_result, (unsigned long)rx_content_len, (unsigned long)srv_res, err);
    req->complete = true;
    req->status_code = srv_res;
    req->result = httpc_result;
}

FetchImageResult fetch_image(int image, std::string &etag, bool redraw)
{
    auto context = cyw43_arch_async_context();

    // Yeah, yeah, the etag should be a If-None-Match header, but the
    // http_client library doesn't support custom headers.
    const std::string path = build_request_path("/images/" + std::to_string(image), current_device_status(), etag) +
                             (redraw ? "&redraw=1" : "");

    // httpc holds on to these until it calls on_http_req_completed, which can
    // be after the wait below gives up, so they outlive this call, and a new
    // request is refused until the last one has finished
    static FetchImageHttpRequest req;
    static bool running = false;
    if (running && !req.complete)
    {
        printf("Previous fetch image HTTP request still running, skipping\n");
        return FetchImageResult::ERROR;
    }
    req = FetchImageHttpRequest{};

    static httpc_connection_t settings = {};
    settings.headers_done_fn = on_headers_received;
    settings.result_fn = on_http_req_completed;
    settings.altcp_allocator = server_tls_allocator();

    image_buffer_offset = 0;
    image_bytes_received = 0;

    cyw43_arch_lwip_begin();
    const auto ret =
        httpc_get_file_dns(SERVER_HOST, SERVER_PORT, path.c_str(), &settings, on_http_data_received, &req, nullptr);
    cyw43_arch_lwip_end();
    running = ret == ERR_OK;

    if (ret != ERR_OK)
    {
        printf("Error starting fetch image HTTP request: %d\n", ret);
        return FetchImageResult::ERROR;
    }

    const auto request_start = get_absolute_time();

    while (!req.complete)
    {
        async_context_wait_for_work_ms(context, 1000);

        if (absolute_time_diff_us(request_start, get_absolute_time()) > 60LL * 1000 * 1000)
        {
            printf("Fetch image HTTP request timed out after 60s waiting for completion\n");
            return FetchImageResult::ERROR;
        }
    }

    // A 304 never has a body, but lwIP's client reports one that carries the
    // entity's Content-Length (allowed, RFC 9110 section 8.6) as
    // HTTPC_RESULT_ERR_CONTENT_LEN. It still means "not modified".
    if (req.status_code == 304 && req.result == HTTPC_RESULT_ERR_CONTENT_LEN)
    {
        return FetchImageResult::NO_CHANGE;
    }

    if (req.result != HTTPC_RESULT_OK)
    {
        printf("Fetch image HTTP request failed with error: %d\n", req.result);
        return FetchImageResult::ERROR;
    }

    if (req.status_code == 200)
    {
        if (image_bytes_received != image_buffer.size())
        {
            printf("Image is the wrong size: %u bytes received, %u expected\n", (unsigned)image_bytes_received,
                   (unsigned)image_buffer.size());
            return FetchImageResult::ERROR;
        }

        // Only adopt the new etag once the full image has arrived — adopting
        // it on a truncated body would make the server 304 us forever for an
        // image we never displayed.
        if (!req.new_etag.empty())
        {
            etag = req.new_etag;
        }

        return FetchImageResult::NEW_IMAGE;
    }
    else if (req.status_code == 304)
    {
        return FetchImageResult::NO_CHANGE;
    }
    else
    {
        printf("Fetch image HTTP request failed with status code: %lu\n", (unsigned long)req.status_code);
        return FetchImageResult::ERROR;
    }
}
