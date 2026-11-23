#ifndef __LWIPOPTS_H__
#define __LWIPOPTS_H__

// Common settings used in most of the pico_w examples
// (see https://www.nongnu.org/lwip/2_1_x/group__lwip__opts.html for details)

// allow override in some examples
#ifndef NO_SYS
#define NO_SYS 1
#endif
// allow override in some examples
#ifndef LWIP_SOCKET
#define LWIP_SOCKET 0
#endif
#if PICO_CYW43_ARCH_POLL
#define MEM_LIBC_MALLOC 1
#else
// MEM_LIBC_MALLOC is incompatible with non polling versions
#define MEM_LIBC_MALLOC 0
#endif
#define MEM_ALIGNMENT 4
// lwIP's own heap: TCP_WRITE_FLAG_COPY copies, plus each TLS connection's
// state (with its mbedTLS context) and the shared TLS config, which
// altcp_tls_mbedtls takes from here rather than from malloc
#define MEM_SIZE           12000
#define MEMP_NUM_TCP_SEG   32
#define MEMP_NUM_ARP_QUEUE 10
#define PBUF_POOL_SIZE     24
#define LWIP_ARP           1
#define LWIP_ETHERNET      1
#define LWIP_ICMP          1
#define LWIP_RAW           1
// mbedTLS can only decrypt a TLS record (up to 16 KB plus its header and tag)
// once all of it is in, and its bytes count against the window until the
// application has taken them, so the window must hold a whole record with
// room to spare, or the connection stalls (see altcp_tls_mbedtls.c). The OTA
// download's staging buffer must match it (see ota.cpp).
#define TCP_WND                    (18 * 1024)
#define TCP_MSS                    1460
#define TCP_SND_BUF                (8 * TCP_MSS)
#define TCP_SND_QUEUELEN           ((4 * (TCP_SND_BUF) + (TCP_MSS - 1)) / (TCP_MSS))
#define LWIP_NETIF_STATUS_CALLBACK 1
#define LWIP_NETIF_LINK_CALLBACK   1
#define LWIP_NETIF_HOSTNAME        1
#define LWIP_NETCONN               0
#define MEM_STATS                  0
#define SYS_STATS                  0
#define MEMP_STATS                 0
#define LINK_STATS                 0
// #define ETH_PAD_SIZE                2
#define LWIP_CHKSUM_ALGORITHM     3
#define LWIP_DHCP                 1
#define LWIP_IPV4                 1
#define LWIP_TCP                  1
#define LWIP_UDP                  1
#define LWIP_DNS                  1
#define LWIP_TCP_KEEPALIVE        1
#define LWIP_TCP_TIMESTAMPS       1
#define LWIP_NETIF_TX_SINGLE_PBUF 1
#define DHCP_DOES_ARP_CHECK       0
#define LWIP_DHCP_DOES_ACD_CHECK  0

#ifndef NDEBUG
#define LWIP_DEBUG         1
#define LWIP_STATS         1
#define LWIP_STATS_DISPLAY 1
#endif

#define ETHARP_DEBUG     LWIP_DBG_OFF
#define NETIF_DEBUG      LWIP_DBG_OFF
#define PBUF_DEBUG       LWIP_DBG_OFF
#define API_LIB_DEBUG    LWIP_DBG_OFF
#define API_MSG_DEBUG    LWIP_DBG_OFF
#define SOCKETS_DEBUG    LWIP_DBG_OFF
#define ICMP_DEBUG       LWIP_DBG_OFF
#define INET_DEBUG       LWIP_DBG_OFF
#define IP_DEBUG         LWIP_DBG_OFF
#define IP_REASS_DEBUG   LWIP_DBG_OFF
#define RAW_DEBUG        LWIP_DBG_OFF
#define MEM_DEBUG        LWIP_DBG_OFF
#define MEMP_DEBUG       LWIP_DBG_OFF
#define SYS_DEBUG        LWIP_DBG_OFF
#define TCP_DEBUG        LWIP_DBG_OFF
#define TCP_INPUT_DEBUG  LWIP_DBG_OFF
#define TCP_OUTPUT_DEBUG LWIP_DBG_OFF
#define TCP_RTO_DEBUG    LWIP_DBG_OFF
#define TCP_CWND_DEBUG   LWIP_DBG_OFF
#define TCP_WND_DEBUG    LWIP_DBG_OFF
#define TCP_FR_DEBUG     LWIP_DBG_OFF
#define TCP_QLEN_DEBUG   LWIP_DBG_OFF
#define TCP_RST_DEBUG    LWIP_DBG_OFF
#define UDP_DEBUG        LWIP_DBG_OFF
#define TCPIP_DEBUG      LWIP_DBG_OFF
#define PPP_DEBUG        LWIP_DBG_OFF
#define SLIP_DEBUG       LWIP_DBG_OFF
#define DHCP_DEBUG       LWIP_DBG_OFF

// TLS (https:// and wss://) through mbedTLS; see tls.cpp
#define LWIP_ALTCP             1
#define LWIP_ALTCP_TLS         1
#define LWIP_ALTCP_TLS_MBEDTLS 1
// A TLS connection takes two altcp pcbs (its TLS layer's and its TCP's), but
// lwIP's default is one per TCP pcb: room for every TCP pcb to carry TLS
#define MEMP_NUM_ALTCP_PCB (2 * MEMP_NUM_TCP_PCB)
// altcp_tls_mbedtls defaults to MBEDTLS_SSL_VERIFY_OPTIONAL, which completes
// the handshake whatever the certificate. Refuse a server that can't prove
// who it is.
#define ALTCP_MBEDTLS_AUTHMODE MBEDTLS_SSL_VERIFY_REQUIRED

#define HTTPC_CLIENT_AGENT "eHymnBoard/1.0 (Pico W); Michael Spencer <sonrisesoftware@gmail.com>"

#endif /* __LWIPOPTS_H__ */
