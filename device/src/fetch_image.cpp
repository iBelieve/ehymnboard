/*
 * eHymnBoard device firmware
 * Copyright (C) 2025  Michael Spencer <sonrisesoftware@gmail.com>

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

#include "pico/async_context.h"
#include "pico/cyw43_arch.h"
#include "state.h"
#include "utils.h"

size_t image_buffer_offset = 0;

struct FetchImageHttpRequest
{
    bool complete = false;
    httpc_result_t result;
    u32_t status_code;

    // Captured from the response headers; only adopted by the caller once
    // the full image body has been received.
    std::string new_etag;
};

err_t on_headers_received([[maybe_unused]] httpc_state_t *connection, void *arg, struct pbuf *hdr,
                          [[maybe_unused]] u16_t hdr_len, [[maybe_unused]] u32_t content_len)
{
    assert(arg);
    FetchImageHttpRequest *req = (FetchImageHttpRequest *)arg;

    auto offset = pbuf_strstr(hdr, "Etag: ");

    if (offset == 0xFFFF)
    {
        printf("WARNING: Etag not found in headers\n");
    }
    else
    {
        auto etag_start = offset + 6;
        auto etag_end = pbuf_memfind(hdr, "\r\n", 2, etag_start);

        if (etag_end == 0xFFFF)
        {
            printf("WARNING: End of Etag header not found\n");
        }
        else
        {
            req->new_etag.assign((char *)hdr->payload + etag_start, etag_end - etag_start);
            printf("Etag: %s\n", req->new_etag.c_str());
        }
    }

    return ERR_OK;
}

err_t on_http_data_received([[maybe_unused]] void *arg, struct altcp_pcb *conn, struct pbuf *p,
                            [[maybe_unused]] err_t err)
{
    assert(arg);

    auto space_left = image_buffer.size() - image_buffer_offset;
    auto bytes_to_copy = p->tot_len < space_left ? p->tot_len : space_left;

    auto bytes_copied = pbuf_copy_partial(p, image_buffer.data() + image_buffer_offset, bytes_to_copy, 0);

    if (bytes_copied == 0)
    {
        printf("Error copying data to image buffer\n");
        return ERR_BUF;
    }

    image_buffer_offset += bytes_copied;

    printf("Received %d, copied %d, total %u bytes\n", p->tot_len, bytes_copied, (unsigned)image_buffer_offset);

    altcp_recved(conn, p->tot_len);
    pbuf_free(p);

    return ERR_OK;
}

void on_http_req_completed(void *arg, httpc_result_t httpc_result, u32_t rx_content_len, u32_t srv_res, err_t err)
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

FetchImageResult fetch_image(int image, std::string &etag)
{
    auto context = cyw43_arch_async_context();

    std::string path = "/images/" + std::to_string(image) + "?device_id=" + unique_board_id +
                       "&saved_state_writes=" + std::to_string(flash_saved_state->write_count) +
                       "&watchdog_caused_reboot=" + std::to_string(watchdog_caused_reboot());

    // Yeah, yeah, this should be a If-None-Match header, but the http_client
    // library doesn't support custom headers.
    if (!etag.empty())
    {
        path += "&etag=" + etag;
    }

    FetchImageHttpRequest req;

    httpc_connection_t settings = {};
    settings.headers_done_fn = on_headers_received;
    settings.result_fn = on_http_req_completed;

    image_buffer_offset = 0;

    cyw43_arch_lwip_begin();
    auto ret = httpc_get_file_dns("api.hymnboard.sonrise.io", 80, path.c_str(), &settings, on_http_data_received, &req,
                                  nullptr);
    cyw43_arch_lwip_end();

    if (ret != ERR_OK)
    {
        printf("Error starting fetch image HTTP request: %d\n", ret);
        return FetchImageResult::ERROR;
    }

    auto request_start = get_absolute_time();

    while (!req.complete)
    {
        async_context_wait_for_work_ms(context, 1000);

        if (absolute_time_diff_us(request_start, get_absolute_time()) > 60ll * 1000 * 1000)
        {
            printf("Fetch image HTTP request timed out after 60s waiting for completion\n");
            return FetchImageResult::ERROR;
        }
    }

    if (req.result != HTTPC_RESULT_OK)
    {
        printf("Fetch image HTTP request failed with error: %d\n", req.result);
        return FetchImageResult::ERROR;
    }

    if (req.status_code == 200)
    {
        if (image_buffer_offset != image_buffer.size())
        {
            printf("Image buffer not full, only %u bytes received, %u expected\n", (unsigned)image_buffer_offset,
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
