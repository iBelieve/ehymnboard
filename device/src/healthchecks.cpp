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
#include "state.h"
#include "utils.h"

struct HealthcheckRequest
{
    bool complete = false;
    httpc_result_t result;
    u32_t status_code;
};

void on_healthcheck_request_completed(void *arg, httpc_result_t httpc_result, u32_t rx_content_len, u32_t srv_res,
                                      err_t err)
{
    assert(arg);
    HealthcheckRequest *req = (HealthcheckRequest *)arg;

    printf("Healthcheck completed with result: %d, server response: %d, error: %d\n", httpc_result, srv_res, err);

    req->complete = true;
    req->status_code = srv_res;
    req->result = httpc_result;
}

err_t on_healthcheck_data_received(void *arg, struct altcp_pcb *conn, struct pbuf *p, err_t err)
{
    assert(arg);

    // Nothing to do here

    altcp_recved(conn, p->tot_len);
    pbuf_free(p);

    return ERR_OK;
}

void send_healthcheck_request(const std::string &path)
{
    auto context = cyw43_arch_async_context();

    std::string full_path = path + "?device_id=" + unique_board_id +
                            "&saved_state_writes=" + std::to_string(flash_saved_state->write_count) +
                            "&watchdog_caused_reboot=" + std::to_string(watchdog_caused_reboot());

    HealthcheckRequest req;

    httpc_connection_t settings = {};
    settings.result_fn = on_healthcheck_request_completed;

    async_context_acquire_lock_blocking(context);

    auto ret = httpc_get_file_dns("api.hymnboard.sonrise.io", 80, full_path.c_str(), &settings,
                                  on_healthcheck_data_received, &req, nullptr);
    async_context_release_lock(context);

    if (ret != ERR_OK)
    {
        printf("Error starting healthcheck HTTP request: %d\n", ret);
        return;
    }

    while (!req.complete)
    {
        async_context_poll(context);
        async_context_wait_for_work_ms(context, 1000);
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
        printf("Failed to report healthcheck: status=%d\n", req.status_code);
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
