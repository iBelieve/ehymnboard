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

#include "healthchecks.h"

#include <string>

#include "lwip/apps/http_client.h"
#include "pico/async_context.h"
#include "pico/cyw43_arch.h"
#include "request_path.h"
#include "utils.h"

namespace
{

struct HealthcheckRequest
{
    bool complete = false;
    httpc_result_t result = HTTPC_RESULT_ERR_UNKNOWN;
    u32_t status_code = 0;
};

} // namespace

static void on_healthcheck_request_completed(void *arg, httpc_result_t httpc_result,
                                             [[maybe_unused]] u32_t rx_content_len, u32_t srv_res, err_t err)
{
    assert(arg);
    HealthcheckRequest *req = (HealthcheckRequest *)arg;

    printf("Healthcheck completed with result: %d, server response: %lu, error: %d\n", httpc_result,
           (unsigned long)srv_res, err);

    req->complete = true;
    req->status_code = srv_res;
    req->result = httpc_result;
}

static err_t on_healthcheck_data_received([[maybe_unused]] void *arg, struct altcp_pcb *conn, struct pbuf *p,
                                          [[maybe_unused]] err_t err)
{
    assert(arg);

    // Nothing to do here

    altcp_recved(conn, p->tot_len);
    pbuf_free(p);

    return ERR_OK;
}

static void send_healthcheck_request(const std::string &path)
{
    auto context = cyw43_arch_async_context();

    const std::string full_path = build_request_path(path, current_device_status());

    HealthcheckRequest req;

    httpc_connection_t settings = {};
    settings.result_fn = on_healthcheck_request_completed;

    cyw43_arch_lwip_begin();
    auto ret = httpc_get_file_dns("api.hymnboard.sonrise.io", 80, full_path.c_str(), &settings,
                                  on_healthcheck_data_received, &req, nullptr);
    cyw43_arch_lwip_end();

    if (ret != ERR_OK)
    {
        printf("Error starting healthcheck HTTP request: %d\n", ret);
        return;
    }

    auto request_start = get_absolute_time();

    while (!req.complete)
    {
        async_context_wait_for_work_ms(context, 1000);

        if (absolute_time_diff_us(request_start, get_absolute_time()) > 60LL * 1000 * 1000)
        {
            printf("Healthcheck HTTP request timed out after 60s waiting for completion\n");
            return;
        }
    }

    if (req.result != HTTPC_RESULT_OK)
    {
        printf("Healthcheck HTTP request failed with error: %d\n", req.result);
        return;
    }

    if (req.status_code == 204)
    {
        printf("Successfully reported healthcheck to server\n");
    }
    else
    {
        printf("Failed to report healthcheck: status=%lu\n", (unsigned long)req.status_code);
    }
}

void report_device_booted()
{
    send_healthcheck_request("/device_booted");
}

void report_device_healthy()
{
    send_healthcheck_request("/device_healthy");
}
