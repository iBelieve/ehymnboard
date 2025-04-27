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

#include "wifi.h"

#include <algorithm>
#include <map>
#include <string>
#include <vector>

#include "pico/cyw43_arch.h"
#include "pico/stdlib.h"
#include "secrets.h"
#include "utils.h"

int on_wifi_scan_complete(void *env, const cyw43_ev_scan_result_t *result);

struct WiFiScanResult
{
    std::string ssid;
    uint8_t bssid[6];
    int16_t rssi;

    WiFiScanResult(const cyw43_ev_scan_result_t *result) : ssid((char *)result->ssid), rssi(result->rssi)
    {
        memcpy(bssid, result->bssid, sizeof(bssid));
    }
};

class WiFiScan
{
  public:
    void run()
    {
        printf("Starting WiFi scan...\n");
        cyw43_wifi_scan_options_t opts = {};

        cyw43_wifi_scan(&cyw43_state, &opts, this, on_wifi_scan_complete);

        while (cyw43_wifi_scan_active(&cyw43_state))
        {
            printf(" -> Waiting for scan to complete...\n");
            sleep_ms(1000);
        }

        std::sort(results.begin(), results.end(), [](const WiFiScanResult &a, const WiFiScanResult &b) {
            return a.rssi > b.rssi; // stronger signal first
        });
        printf("WiFi scan complete. Results:\n");

        for (const auto &result : results)
        {
            printf("- %-32s   rssi: %d\n", result.ssid.c_str(), result.rssi);
        }
    }

    std::vector<WiFiScanResult> results;
};

int on_wifi_scan_complete(void *env, const cyw43_ev_scan_result_t *result)
{
    if (result == nullptr)
    {
        printf("Scan result is null\n");
        return 0;
    }

    assert(env);
    WiFiScan *scan = (WiFiScan *)env;

    WiFiScanResult scan_result(result);

    if (scan_result.ssid.empty())
    {
        printf(" -> Skipping empty SSID\n");
        return 0;
    }

    printf(" -> Found SSID: %s, MAC: %02x:%02x:%02x:%02x:%02x:%02x, RSSI: %d\n", scan_result.ssid.c_str(),
           scan_result.bssid[0], scan_result.bssid[1], scan_result.bssid[2], scan_result.bssid[3], scan_result.bssid[4],
           scan_result.bssid[5], scan_result.rssi);

    auto existingResult = std::find_if(scan->results.begin(), scan->results.end(),
                                       [&scan_result](const WiFiScanResult &r) { return r.ssid == scan_result.ssid; });

    if (existingResult != scan->results.end())
    {
        // Update the existing result if the new one has a stronger signal
        if (scan_result.rssi > existingResult->rssi)
        {
            memcpy(existingResult->bssid, scan_result.bssid, sizeof(scan_result.bssid));
            existingResult->rssi = scan_result.rssi;
        }
    }
    else
    {
        scan->results.push_back(scan_result);
    }

    return 0;
}

void setup_wifi()
{
    // Initialise the Wi-Fi chip
    if (cyw43_arch_init())
    {
        printf("WiFi init failed\n");
        stall_spin();
    }

    // Enable wifi station
    cyw43_arch_enable_sta_mode();

    bool scan_in_progress = false;

    while (true)
    {
        WiFiScan wifi_scan;
        wifi_scan.run();

        bool found_ssid = false;

        for (const auto &result : wifi_scan.results)
        {
            auto entry = WIFI_SSIDS.find(result.ssid);

            if (entry != WIFI_SSIDS.end())
            {
                found_ssid = true;

                auto ssid = entry->first.c_str();
                auto password = entry->second.c_str();

                printf("Tring to connect to SSID %s (MAC %02x:%02x:%02x:%02x:%02x:%02x) with password %s\n", ssid,
                       result.bssid[0], result.bssid[1], result.bssid[2], result.bssid[3], result.bssid[4],
                       result.bssid[5], password);

                for (int i = 0; i < 5; i++)
                {
                    int res = cyw43_arch_wifi_connect_bssid_timeout_ms(ssid, result.bssid, password,
                                                                       CYW43_AUTH_WPA2_AES_PSK, 30000);

                    if (res == PICO_OK)
                    {
                        printf("- Connected to %s\n", ssid);
                        return;
                    }
                    else if (res == PICO_ERROR_BADAUTH)
                    {
                        printf("- Bad auth for %s\n", ssid);
                    }
                    else if (res == PICO_ERROR_TIMEOUT)
                    {
                        printf("- Timeout connecting to %s\n", ssid);
                    }
                    else if (res == PICO_ERROR_CONNECT_FAILED)
                    {
                        printf("- Connection failed for %s\n", ssid);
                    }
                    else
                    {
                        printf("- Unknown error connecting to %s: %d\n", ssid, res);
                    }

                    sleep_ms(1000);
                    printf("- Retrying connection...\n", ssid);
                }
            }
        }

        if (found_ssid)
        {
            printf("All attempts to connect to known SSIDs failed. Sleeping "
                   "for 30s "
                   "then rescanning...\n");
            sleep_ms(30 * 1000);
        }
        else
        {
            printf("No known SSIDs found. Sleeping for 60s then rescanning...\n");
            sleep_ms(60 * 1000);
        }
    }
}
