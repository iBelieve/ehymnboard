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

// mbedTLS build options for this firmware: a TLS 1.2 client for
// hymnboard.sonrise.io (behind Cloudflare), with as little else as
// possible. pico-sdk's pico_mbedtls includes this file by name; this
// directory comes before pico_fota_bootloader's include directory, whose
// mbedtls_config.h (AES and SHA-256 for the OTA image) is a subset of this
// one. Its options are repeated here so the AES and SHA-256 code both
// sides link against is built the same way.

#pragma once

// tls.cpp checks that this file, and not the bootloader's, is in use
#define EHYMNBOARD_MBEDTLS_CONFIG 1

// --- Shared with pico_fota_bootloader's OTA image decryption ---------------
#define MBEDTLS_AES_C
#define MBEDTLS_AES_FEWER_TABLES
#define MBEDTLS_SHA256_C
#define MBEDTLS_SHA256_SMALLER

// --- Platform ----------------------------------------------------------------
// pico-sdk's altcp_tls_mbedtls.c reads mbedTLS's private fields, and its
// session resumption needs MBEDTLS_HAVE_TIME (time(), which counts from boot
// here). No MBEDTLS_HAVE_TIME_DATE: the board has no real clock, so
// certificates' dates aren't checked. mbedTLS allocates through tls.cpp,
// which counts what it uses.
#define MBEDTLS_ALLOW_PRIVATE_ACCESS
#define MBEDTLS_HAVE_TIME
// mbedtls_ms_time() comes from tls.cpp (milliseconds since boot)
#define MBEDTLS_PLATFORM_MS_TIME_ALT
#define MBEDTLS_PLATFORM_C
#define MBEDTLS_PLATFORM_MEMORY
#define MBEDTLS_PLATFORM_CALLOC_MACRO ehymnboard_tls_calloc
#define MBEDTLS_PLATFORM_FREE_MACRO   ehymnboard_tls_free
#define MBEDTLS_NO_PLATFORM_ENTROPY
// pico_mbedtls provides mbedtls_hardware_poll() from the RP2040's ring
// oscillator (pico_rand)
#define MBEDTLS_ENTROPY_HARDWARE_ALT
#define MBEDTLS_ENTROPY_C
#define MBEDTLS_CTR_DRBG_C

#include <stddef.h>
#ifdef __cplusplus
extern "C"
{
#endif
    void *ehymnboard_tls_calloc(size_t count, size_t size);
    void ehymnboard_tls_free(void *ptr);
#ifdef __cplusplus
}
#endif

// --- TLS 1.2 client ------------------------------------------------------------
#define MBEDTLS_SSL_TLS_C
#define MBEDTLS_SSL_CLI_C
#define MBEDTLS_SSL_PROTO_TLS1_2
#define MBEDTLS_SSL_SERVER_NAME_INDICATION
#define MBEDTLS_SSL_EXTENDED_MASTER_SECRET
#define MBEDTLS_SSL_SESSION_TICKETS
// A server may send records of up to 16 KB (Cloudflare doesn't negotiate
// smaller ones). What the board sends is short: requests, and WebSocket
// frames that ws_client.cpp writes a TCP segment at a time.
#define MBEDTLS_SSL_IN_CONTENT_LEN  16384
#define MBEDTLS_SSL_OUT_CONTENT_LEN 2048
// The server's certificates are freed once the handshake has checked them
// (MBEDTLS_SSL_KEEP_PEER_CERTIFICATE is off)

// ECDHE key exchange, ECDSA or RSA certificates, AEAD ciphers only.
// ChaCha20-Poly1305 comes first: without AES instructions, the M0+ decrypts it
// several times faster than AES-GCM, and Cloudflare (like OpenSSL) takes the
// client's preference between the two.
#define MBEDTLS_KEY_EXCHANGE_ECDHE_ECDSA_ENABLED
#define MBEDTLS_KEY_EXCHANGE_ECDHE_RSA_ENABLED
#define MBEDTLS_SSL_CIPHERSUITES                                                                                       \
    MBEDTLS_TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256, MBEDTLS_TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256,        \
        MBEDTLS_TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256, MBEDTLS_TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256
#define MBEDTLS_GCM_C
#define MBEDTLS_CHACHA20_C
#define MBEDTLS_POLY1305_C
#define MBEDTLS_CHACHAPOLY_C
#define MBEDTLS_CIPHER_C
#define MBEDTLS_MD_C

// --- Public key crypto -----------------------------------------------------------
#define MBEDTLS_BIGNUM_C
#define MBEDTLS_ECP_C
#define MBEDTLS_ECDH_C
#define MBEDTLS_ECDSA_C
#define MBEDTLS_ECP_DP_SECP256R1_ENABLED
#define MBEDTLS_ECP_DP_SECP384R1_ENABLED
#define MBEDTLS_ECP_NIST_OPTIM
// mbedTLS's Thumb-1 assembly for bignum multiply-accumulate, instead of a
// call to the 64-bit multiply helper for every word
#define MBEDTLS_HAVE_ASM
#define MBEDTLS_RSA_C
#define MBEDTLS_PKCS1_V15
#define MBEDTLS_PKCS1_V21
#define MBEDTLS_SHA384_C
#define MBEDTLS_SHA512_C

// --- Certificates ------------------------------------------------------------------
#define MBEDTLS_ASN1_PARSE_C
#define MBEDTLS_ASN1_WRITE_C
#define MBEDTLS_OID_C
#define MBEDTLS_PK_C
#define MBEDTLS_PK_PARSE_C
#define MBEDTLS_X509_USE_C
#define MBEDTLS_X509_CRT_PARSE_C
// The root CAs stay in flash, and tls.cpp parses only the one a handshake
// needs (see find_trusted_roots)
#define MBEDTLS_X509_TRUSTED_CERTIFICATE_CALLBACK
