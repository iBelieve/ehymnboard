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

uintptr_t image_buffer_offset = 0;

struct HttpRequest
{
    bool complete = false;
    httpc_result_t result;
    u32_t status_code;
    std::string &etag;

    HttpRequest(std::string &etag) : etag(etag)
    {
    }
};

err_t on_headers_received(httpc_state_t *connection, void *arg, struct pbuf *hdr, u16_t hdr_len, u32_t content_len)
{
    assert(arg);
    HttpRequest *req = (HttpRequest *)arg;

    auto offset = pbuf_strstr(hdr, "ETag: ");

    if (offset == 0xFFFF)
    {
        printf("WARNING: ETag not found in headers\n");
    }
    else
    {
        auto etag_start = offset + 6;
        auto etag_end = pbuf_memfind(hdr, "\r\n", 2, etag_start);

        if (etag_end == 0xFFFF)
        {
            printf("WARNING: End of ETag header not found\n");
        }
        else
        {
            req->etag.assign((char *)hdr->payload + etag_start, etag_end - etag_start);
            printf("ETag: %s\n", req->etag.c_str());
        }
    }

    return ERR_OK;
}

err_t on_http_data_received(void *arg, struct altcp_pcb *conn, struct pbuf *p, err_t err)
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

    printf("Received %d, copied %d, total %d bytes\n", p->tot_len, bytes_copied, image_buffer_offset);

    altcp_recved(conn, p->tot_len);
    pbuf_free(p);

    return ERR_OK;
}

void on_http_req_completed(void *arg, httpc_result_t httpc_result, u32_t rx_content_len, u32_t srv_res, err_t err)
{
    assert(arg);
    HttpRequest *req = (HttpRequest *)arg;

    printf("HTTP request completed with result: %d, content length: %d, server "
           "response: %d, error: %d\n",
           httpc_result, rx_content_len, srv_res, err);
    req->complete = true;
    req->status_code = srv_res;
    req->result = httpc_result;
}

FetchImageResult fetch_image(int image, std::string &etag)
{
    auto context = cyw43_arch_async_context();

    std::string path = "/images/" + std::to_string(image) + "?device_id=" + unique_board_id +
                       "&saved_state_writes=" + std::to_string(flash_saved_state->write_count);

    // Yeah, yeah, this should be a If-None-Match header, but the http_client
    // library doesn't support custom headers.
    if (!etag.empty())
    {
        path += "&etag=" + etag;
    }

    HttpRequest req(etag);

    httpc_connection_t settings = {};
    settings.headers_done_fn = on_headers_received;
    settings.result_fn = on_http_req_completed;

    image_buffer_offset = 0;

    auto ret = httpc_get_file_dns("api.hymnboard.sonrise.io", 80, path.c_str(), &settings, on_http_data_received, &req,
                                  nullptr);

    if (ret != ERR_OK)
    {
        printf("Error starting HTTP request: %d\n", ret);
        return FetchImageResult::ERROR;
    }

    while (!req.complete)
    {
        async_context_poll(context);
        async_context_wait_for_work_ms(context, 1000);
    }

    if (req.result != HTTPC_RESULT_OK)
    {
        printf("HTTP request failed with error: %d\n", req.result);
        return FetchImageResult::ERROR;
    }

    if (req.status_code == 200)
    {
        if (image_buffer_offset != image_buffer.size())
        {
            printf("Image buffer not full, only %d bytes received, %d expected\n", image_buffer_offset,
                   image_buffer.size());
            return FetchImageResult::ERROR;
        }

        return FetchImageResult::NEW_IMAGE;
    }
    else if (req.status_code == 304)
    {
        return FetchImageResult::NO_CHANGE;
    }
    else
    {
        printf("HTTP request failed with status code: %d\n", req.status_code);
        return FetchImageResult::ERROR;
    }
}
