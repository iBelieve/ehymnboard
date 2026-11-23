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

#include "tls.h"

#include <malloc.h>

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#include "lwip/altcp_tls.h"
#include "mbedtls/platform.h"
#include "mbedtls/platform_time.h"
#include "mbedtls/ssl.h"
#include "mbedtls/x509_crt.h"
#include "pico/time.h"
#include "tls_roots.h"
#include "utils.h"

#ifndef EHYMNBOARD_MBEDTLS_CONFIG
#error "mbedTLS isn't using device/src/mbedtls_config.h"
#endif

// --- Memory --------------------------------------------------------------------

namespace
{

// Each allocation carries its size, so frees can be counted. Eight bytes keep
// the block as aligned as malloc's.
struct alignas(8) AllocationHeader
{
    std::size_t size;
};

} // namespace

// Allocations at least this big sample the heap's use (see ehymnboard_tls_calloc)
static constexpr std::size_t HEAP_SAMPLE_BYTES = 1024;

static std::size_t tls_bytes_now = 0;
static std::size_t tls_bytes_peak = 0;
static std::size_t heap_bytes_peak = 0;

// The heap runs from the end of .bss to __HeapLimit (pico-sdk's sbrk)
// NOLINTBEGIN(bugprone-reserved-identifier,cert-dcl37-c,cert-dcl51-cpp): the linker script's names
extern "C" char __end__;
extern "C" char __HeapLimit;
// NOLINTEND(bugprone-reserved-identifier,cert-dcl37-c,cert-dcl51-cpp)

static std::size_t heap_in_use()
{
    // NOLINTNEXTLINE(concurrency-mt-unsafe): it takes newlib's malloc lock (malloc_lock.cpp)
    return mallinfo().uordblks;
}

// mbedTLS's calloc (MBEDTLS_PLATFORM_CALLOC_MACRO). It runs in lwIP's
// context, so these counters only change there.
extern "C" void *ehymnboard_tls_calloc(std::size_t count, std::size_t size)
{
    if (size != 0 && count > (SIZE_MAX - sizeof(AllocationHeader)) / size)
    {
        return nullptr;
    }
    const std::size_t bytes = count * size;
    // NOLINTNEXTLINE(cppcoreguidelines-no-malloc,hicpp-no-malloc): mbedTLS frees through ehymnboard_tls_free
    auto *header = static_cast<AllocationHeader *>(calloc(1, sizeof(AllocationHeader) + bytes));
    if (header == nullptr)
    {
        printf("TLS: out of memory for %u bytes (mbedTLS has %u)\n", static_cast<unsigned>(bytes),
               static_cast<unsigned>(tls_bytes_now));
        return nullptr;
    }
    header->size = bytes;
    tls_bytes_now += bytes;
    // mallinfo walks the free lists with interrupts off (malloc_lock.cpp), so
    // only look at the heap when mbedTLS reaches a new peak or takes a big
    // block, not for each of a handshake's thousands of small ones
    if (tls_bytes_now > tls_bytes_peak || bytes >= HEAP_SAMPLE_BYTES)
    {
        heap_bytes_peak = std::max(heap_bytes_peak, heap_in_use());
    }
    tls_bytes_peak = std::max(tls_bytes_peak, tls_bytes_now);
    return header + 1;
}

extern "C" void ehymnboard_tls_free(void *ptr)
{
    if (ptr == nullptr)
    {
        return;
    }
    auto *header = static_cast<AllocationHeader *>(ptr) - 1;
    tls_bytes_now -= header->size;
    // NOLINTNEXTLINE(cppcoreguidelines-no-malloc,hicpp-no-malloc): allocated by ehymnboard_tls_calloc
    free(header);
}

TlsMemory tls_memory()
{
    return TlsMemory{
        .tls_now = tls_bytes_now,
        .tls_peak = tls_bytes_peak,
        .heap_now = heap_in_use(),
        .heap_peak = heap_bytes_peak,
        // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast): two linker symbols' addresses
        .heap_size = reinterpret_cast<std::uintptr_t>(&__HeapLimit) - reinterpret_cast<std::uintptr_t>(&__end__),
    };
}

void tls_log_memory()
{
    const auto memory = tls_memory();
    printf("TLS: heap %u in use, peak %u of %u (mbedTLS %u, peak %u)\n", static_cast<unsigned>(memory.heap_now),
           static_cast<unsigned>(memory.heap_peak), static_cast<unsigned>(memory.heap_size),
           static_cast<unsigned>(memory.tls_now), static_cast<unsigned>(memory.tls_peak));
}

// mbedTLS's clock (MBEDTLS_PLATFORM_MS_TIME_ALT), for session lifetimes
extern "C" mbedtls_ms_time_t mbedtls_ms_time()
{
    return static_cast<mbedtls_ms_time_t>(to_ms_since_boot(get_absolute_time()));
}

// --- Certificates ----------------------------------------------------------------

// Whether two strings in names are the same, as mbedTLS compares them when
// it matches a certificate to its issuer (x509_string_cmp): byte for byte, or
// ignoring ASCII case between UTF8String and PrintableString encodings
static bool same_name_string(const mbedtls_x509_buf &a, const mbedtls_x509_buf &b)
{
    if (a.len != b.len)
    {
        return false;
    }
    if (a.tag == b.tag && std::memcmp(a.p, b.p, a.len) == 0)
    {
        return true;
    }
    const auto is_text = [](int tag) {
        return tag == MBEDTLS_ASN1_UTF8_STRING || tag == MBEDTLS_ASN1_PRINTABLE_STRING;
    };
    if (!is_text(a.tag) || !is_text(b.tag))
    {
        return false;
    }
    for (std::size_t i = 0; i < a.len; i++)
    {
        const auto lower = [](unsigned char c) { return c >= 'A' && c <= 'Z' ? c - 'A' + 'a' : c; };
        if (lower(a.p[i]) != lower(b.p[i]))
        {
            return false;
        }
    }
    return true;
}

// Whether two names are the same, as mbedTLS compares them (x509_name_cmp)
static bool same_name(const mbedtls_x509_name *a, const mbedtls_x509_name *b)
{
    for (; a != nullptr && b != nullptr; a = a->next, b = b->next)
    {
        if (a->oid.tag != b->oid.tag || a->oid.len != b->oid.len || std::memcmp(a->oid.p, b->oid.p, a->oid.len) != 0 ||
            !same_name_string(a->val, b->val) || a->next_merged != b->next_merged)
        {
            return false;
        }
    }
    return a == nullptr && b == nullptr;
}

// mbedTLS asks for the trusted roots that could have issued `child`, for each
// certificate of the chain the server sent in turn. The roots are parsed
// straight from flash (no copy) and only those whose name matches are kept,
// so the roots cost no RAM between handshakes; mbedTLS frees the chain
// afterwards. Running out of memory fails the handshake as that, rather than
// as a chain from no trusted root.
static int find_trusted_roots([[maybe_unused]] void *context, const mbedtls_x509_crt *child,
                              mbedtls_x509_crt **candidates)
{
    mbedtls_x509_crt *chain = nullptr;
    int result = 0;
    for (const auto &root : TLS_ROOTS)
    {
        auto *crt = static_cast<mbedtls_x509_crt *>(mbedtls_calloc(1, sizeof(mbedtls_x509_crt)));
        if (crt == nullptr)
        {
            result = MBEDTLS_ERR_X509_ALLOC_FAILED;
            break;
        }
        mbedtls_x509_crt_init(crt);
        const int parsed = mbedtls_x509_crt_parse_der_nocopy(crt, root.der, root.length);
        if (parsed != 0 || !same_name(&crt->subject, &child->issuer))
        {
            mbedtls_x509_crt_free(crt);
            mbedtls_free(crt);
            if (parsed == MBEDTLS_ERR_X509_ALLOC_FAILED)
            {
                result = parsed;
                break;
            }
            continue;
        }
        printf("TLS: checking the server's chain against %s\n", root.name);
        crt->next = chain;
        chain = crt;
    }
    if (result != 0)
    {
        printf("TLS: out of memory checking the server's chain\n");
    }
    // mbedTLS frees these even when this fails
    *candidates = chain;
    return result;
}

// Logs why a certificate in the server's chain was refused; the handshake
// then fails
static int log_verify_result([[maybe_unused]] void *context, [[maybe_unused]] mbedtls_x509_crt *crt, int depth,
                             uint32_t *flags)
{
    if (*flags == 0)
    {
        return 0;
    }
    const char *reason = "refused";
    if ((*flags & MBEDTLS_X509_BADCERT_CN_MISMATCH) != 0U)
    {
        reason = "for another name";
    }
    else if ((*flags & MBEDTLS_X509_BADCERT_NOT_TRUSTED) != 0U)
    {
        reason = "not from a trusted root";
    }
    printf("TLS: server certificate %d is %s (flags 0x%lx)\n", depth, reason, static_cast<unsigned long>(*flags));
    return 0;
}

// --- Connections -------------------------------------------------------------------

static struct altcp_tls_config *config = nullptr;
static struct altcp_tls_session session = {};
static bool have_session = false;

static struct altcp_tls_config *create_config()
{
    struct altcp_tls_config *created = altcp_tls_create_config_client(nullptr, 0);
    if (created == nullptr)
    {
        printf("TLS: out of memory for the configuration\n");
        return nullptr;
    }
    // lwIP's altcp_tls_config is opaque, but begins with its
    // mbedtls_ssl_config (altcp_tls_mbedtls.c), and lwIP has no call for a
    // trusted-root callback
    auto *ssl_config = reinterpret_cast<mbedtls_ssl_config *>(created);
    mbedtls_ssl_conf_ca_cb(ssl_config, find_trusted_roots, nullptr);
    mbedtls_ssl_conf_verify(ssl_config, log_verify_result, nullptr);
    return created;
}

struct altcp_pcb *tls_new_connection(void *host, u8_t ip_type)
{
    if (config == nullptr)
    {
        config = create_config();
        if (config == nullptr)
        {
            return nullptr;
        }
    }

    struct altcp_pcb *pcb = altcp_tls_new(config, ip_type);
    if (pcb == nullptr)
    {
        printf("TLS: out of memory for a connection\n");
        return nullptr;
    }

    // Sends the name (SNI), and makes the handshake check the certificate is for it
    auto *ssl = static_cast<mbedtls_ssl_context *>(altcp_tls_context(pcb));
    if (mbedtls_ssl_set_hostname(ssl, static_cast<const char *>(host)) != 0)
    {
        printf("TLS: couldn't set the server name\n");
        altcp_abort(pcb);
        return nullptr;
    }

    if (have_session)
    {
        altcp_tls_set_session(pcb, &session);
    }
    return pcb;
}

static altcp_allocator_t server_allocator = {
    tls_new_connection,
    const_cast<char *>(SERVER_HOST), // NOLINT(cppcoreguidelines-pro-type-const-cast): only ever read
};

altcp_allocator_t *server_tls_allocator()
{
    return &server_allocator;
}

void tls_remember_session(struct altcp_pcb *conn)
{
    // mbedTLS hands out each connection's session once; later calls fail
    // and leave the saved one alone
    struct altcp_tls_session latest = {};
    altcp_tls_init_session(&latest);
    if (altcp_tls_get_session(conn, &latest) != ERR_OK)
    {
        altcp_tls_free_session(&latest);
        return;
    }
    if (have_session)
    {
        altcp_tls_free_session(&session);
    }
    session = latest;
    have_session = true;
}

err_t tls_remember_httpc_session(httpc_state_t *connection, [[maybe_unused]] void *arg,
                                 [[maybe_unused]] struct pbuf *hdr, [[maybe_unused]] u16_t hdr_len,
                                 [[maybe_unused]] u32_t content_len)
{
    // lwIP's httpc_state_t is opaque, but begins with its connection
    // (http_client.c), and httpc has no call for it
    tls_remember_session(*reinterpret_cast<struct altcp_pcb **>(connection));
    return ERR_OK;
}
