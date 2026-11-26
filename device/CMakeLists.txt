# Generated Cmake Pico project file

cmake_minimum_required(VERSION 3.13)

set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# Initialise pico_sdk from installed location
# (note this can come from environment, CMake cache etc)

# == DO NOT EDIT THE FOLLOWING LINES for the Raspberry Pi Pico VS Code Extension to work ==
if(WIN32)
    set(USERHOME $ENV{USERPROFILE})
else()
    set(USERHOME $ENV{HOME})
endif()
set(sdkVersion 2.3.1)
set(toolchainVersion 15_2_Rel1)
set(picotoolVersion 2.3.1)
set(picoVscode ${USERHOME}/.pico-sdk/cmake/pico-vscode.cmake)
if (EXISTS ${picoVscode})
    include(${picoVscode})
endif()
# ====================================================================================
set(PICO_BOARD pico_w CACHE STRING "Board type")

# Pull in Raspberry Pi Pico SDK (must be before project)
include(pico_sdk_import.cmake)

project(ehymnboard C CXX ASM)

# Initialise the Raspberry Pi Pico SDK
pico_sdk_init()

# Over-the-air updates: the firmware runs in place from slot A or slot B of
# flash, linked once for each, and the A/B bootloader (src/bootloader_main.cpp)
# starts one of them, putting new firmware on trial and going back to the
# other slot if it doesn't commit. See src/boot_control.h for the flash
# layout and README.md ("OTA updates").
#
# The OTA image is AES encrypted (it contains the WiFi passphrases from
# secrets.h, and firmware from before TLS downloads it over plain HTTP), so
# builds need a key. Put it in secrets.cmake (see secrets.example.cmake) or
# pass -DPFB_AES_KEY=... (the name is from pico_fota_bootloader, whose boards
# check images with the same key).
include(${CMAKE_CURRENT_LIST_DIR}/secrets.cmake OPTIONAL)
if (NOT PFB_AES_KEY)
    message(FATAL_ERROR "PFB_AES_KEY is not set: copy secrets.example.cmake to secrets.cmake and set a key")
elseif (PFB_AES_KEY STREQUAL "CHANGEME")
    message(WARNING "PFB_AES_KEY is the example key: don't install this build on a board")
endif()
if (NOT PFB_AES_KEY MATCHES "^[0-9a-zA-Z]+$" OR PFB_AES_KEY MATCHES "^.................................")
    message(FATAL_ERROR "PFB_AES_KEY must be at most 32 letters and digits")
endif()
# Padded to 32 characters with 'x', as pico_fota_bootloader does
string(LENGTH ${PFB_AES_KEY} aes_key_length)
math(EXPR aes_key_padding "32 - ${aes_key_length}")
string(REPEAT "x" ${aes_key_padding} aes_key_xs)
set(EHYMNBOARD_OTA_AES_KEY "${PFB_AES_KEY}${aes_key_xs}")

# The image scripts' encryption needs pycryptodome, a uv dev dependency: use
# the uv environment (`uv sync`) when there is one
if (NOT Python_EXECUTABLE AND EXISTS ${CMAKE_CURRENT_LIST_DIR}/.venv/bin/python)
    set(Python_EXECUTABLE ${CMAKE_CURRENT_LIST_DIR}/.venv/bin/python)
endif()
find_package(Python COMPONENTS Interpreter REQUIRED)
set(OTA_IMAGE_SCRIPT ${CMAKE_CURRENT_LIST_DIR}/cmake/ota_image.py)

# pico_fota_bootloader, which boards ran before the A/B bootloader. Only its
# bootloader is built, for the emulator's test of moving a board off it; once
# every board is on the A/B bootloader, it can go.
set(PFB_WITH_IMAGE_ENCRYPTION ON)
set(PFB_WITH_SHA256_HASHING ON)
set(PFB_RESERVED_FILESYSTEM_SIZE_KB 8)
add_subdirectory(lib/pico_fota_bootloader)
set_target_properties(pico_fota_bootloader_lib PROPERTIES EXCLUDE_FROM_ALL ON)

# Links `target` to run from flash at `origin` (an address), with at most
# `length` bytes of image
function(ehymnboard_link_at target origin length)
    set(EHB_FLASH_ORIGIN ${origin})
    set(EHB_FLASH_LENGTH ${length})
    set(script ${CMAKE_CURRENT_BINARY_DIR}/${target}.ld)
    configure_file(${CMAKE_CURRENT_LIST_DIR}/cmake/run_in_place.ld.in ${script} @ONLY)
    pico_set_linker_script(${target} ${script})
endfunction()

# Flash layout, as in src/boot_control.h: the bootloader up to its marker's
# page, and the two slots (each less the image's 256-byte trailer)
set(EHB_BOOTLOADER_ORIGIN 0x10001000)
set(EHB_BOOTLOADER_LENGTH 0x6F00)
set(EHB_SLOT_A_ORIGIN 0x1000A000)
set(EHB_SLOT_B_ORIGIN 0x10104000)
set(EHB_SLOT_LENGTH 0xF9F00)

# CI passes -DWERROR=ON; warnings are treated as errors there, so fix any
# warnings before pushing
option(WERROR "Treat compiler warnings as errors" OFF)

# --- The A/B bootloader -------------------------------------------------------

# Flash's first sector: boot2 and the stub that starts the bootloader (or
# slot A, while there's no complete bootloader)
add_executable(ehymnboard_boot_stub src/boot_stub.S $<TARGET_OBJECTS:bs2_default_library>)
target_link_options(ehymnboard_boot_stub PRIVATE -nostartfiles -nostdlib
    "LINKER:--script=${CMAKE_CURRENT_LIST_DIR}/cmake/boot_stub.ld")
set_target_properties(ehymnboard_boot_stub PROPERTIES LINK_DEPENDS ${CMAKE_CURRENT_LIST_DIR}/cmake/boot_stub.ld)
set(BOOT_STUB_BIN ${CMAKE_CURRENT_BINARY_DIR}/ehymnboard_boot_stub.bin)
add_custom_command(TARGET ehymnboard_boot_stub POST_BUILD
    COMMAND ${CMAKE_OBJCOPY} -O binary $<TARGET_FILE:ehymnboard_boot_stub> ${BOOT_STUB_BIN}
    BYPRODUCTS ${BOOT_STUB_BIN})

add_executable(ehymnboard_bootloader
        src/bootloader_main.cpp
        src/boot_control.cpp
        src/boot_flash.cpp
)
target_compile_options(ehymnboard_bootloader PRIVATE -Os -Wall -Wextra)
if (WERROR)
    target_compile_options(ehymnboard_bootloader PRIVATE -Werror)
endif()
target_link_libraries(ehymnboard_bootloader
        pico_stdlib
        hardware_flash
        hardware_watchdog
        hardware_resets)
pico_enable_stdio_uart(ehymnboard_bootloader 0)
pico_enable_stdio_usb(ehymnboard_bootloader 0)
ehymnboard_link_at(ehymnboard_bootloader ${EHB_BOOTLOADER_ORIGIN} ${EHB_BOOTLOADER_LENGTH})
set(BOOTLOADER_BIN ${CMAKE_CURRENT_BINARY_DIR}/ehymnboard_bootloader.bin)
add_custom_command(TARGET ehymnboard_bootloader POST_BUILD
    COMMAND ${CMAKE_OBJCOPY} -O binary $<TARGET_FILE:ehymnboard_bootloader> ${BOOTLOADER_BIN}
    BYPRODUCTS ${BOOTLOADER_BIN})

# Both parts as one UF2 (with the marker that tells the stub the bootloader
# is complete), for installing over USB and for the emulator
set(BOOTLOADER_UF2 ${CMAKE_CURRENT_BINARY_DIR}/ehymnboard_bootloader.uf2)
add_custom_command(OUTPUT ${BOOTLOADER_UF2}
    COMMAND ${Python_EXECUTABLE} -I ${OTA_IMAGE_SCRIPT} bootloader-uf2 ${BOOT_STUB_BIN} ${BOOTLOADER_BIN}
        ${BOOTLOADER_UF2}
    DEPENDS ehymnboard_boot_stub ehymnboard_bootloader ${OTA_IMAGE_SCRIPT}
    COMMENT "Making the A/B bootloader's UF2")
add_custom_target(ehymnboard_bootloader_uf2 ALL DEPENDS ${BOOTLOADER_UF2})

# TLS: every request and the socket go to https:// and wss:// on this host,
# checked against the root CAs in certs/roots.pem (see src/tls.h)
set(EHYMNBOARD_SERVER_HOST "hymnboard.sonrise.io" CACHE STRING
    "The server's host name, for https:// and wss://")
# For the emulator's tests: also trust certs/test/root.pem, under which this
# repository has a certificate for the server's name together with its private
# key (certs/test/server.key). A build that trusts it must never reach
# a real board, so it needs the example OTA key, whose images real boards
# refuse. CI builds this way.
option(EHYMNBOARD_TEST_ROOT_CA "Also trust the emulator's test root CA (tests only)" OFF)
set(TLS_ROOT_FILES ${CMAKE_CURRENT_LIST_DIR}/certs/roots.pem)
if (EHYMNBOARD_TEST_ROOT_CA)
    if (NOT PFB_AES_KEY STREQUAL "CHANGEME")
        message(FATAL_ERROR "EHYMNBOARD_TEST_ROOT_CA is for test builds, which need the example OTA key "
            "(PFB_AES_KEY CHANGEME): a board must never trust the test CA")
    endif()
    message(WARNING "EHYMNBOARD_TEST_ROOT_CA: this build trusts the test CA; don't install it on a board")
    list(APPEND TLS_ROOT_FILES ${CMAKE_CURRENT_LIST_DIR}/certs/test/root.pem)
endif()
set(TLS_ROOTS_HEADER ${CMAKE_CURRENT_BINARY_DIR}/generated/tls_roots.h)
add_custom_command(
    OUTPUT ${TLS_ROOTS_HEADER}
    COMMAND ${Python_EXECUTABLE} -I ${CMAKE_CURRENT_LIST_DIR}/cmake/embed_roots.py ${TLS_ROOTS_HEADER}
        ${TLS_ROOT_FILES}
    DEPENDS ${CMAKE_CURRENT_LIST_DIR}/cmake/embed_roots.py ${TLS_ROOT_FILES}
    COMMENT "Embedding the TLS root CAs"
)
add_custom_target(ehymnboard_tls_roots DEPENDS ${TLS_ROOTS_HEADER})

# With altcp on (for TLS), pico_lwip_http also builds lwIP's proxy-connect
# code, which -Wextra warns about. It's not ours, and nothing here uses it.
set_source_files_properties(${PICO_LWIP_PATH}/src/apps/http/altcp_proxyconnect.c
    PROPERTIES COMPILE_OPTIONS -Wno-missing-field-initializers)

# What both firmware images need for TLS
function(ehymnboard_use_tls target)
    add_dependencies(${target} ehymnboard_tls_roots)
    target_compile_definitions(${target} PRIVATE EHYMNBOARD_SERVER_HOST="${EHYMNBOARD_SERVER_HOST}")
    target_link_libraries(${target} pico_lwip_mbedtls pico_mbedtls)
    if (EHYMNBOARD_TEST_ROOT_CA)
        target_compile_definitions(${target} PRIVATE EHYMNBOARD_TEST_ROOT_CA=1)
    endif()
endfunction()

# --- The firmware -------------------------------------------------------------

# Regenerate the firmware version on every build (the image and its reported
# version must always match). Also written to firmware_version.txt for
# uploading alongside the OTA bundle.
add_custom_target(ehymnboard_firmware_version
    COMMAND ${CMAKE_COMMAND}
        -DSOURCE_DIR=${CMAKE_CURRENT_LIST_DIR}
        -DOUTPUT_HEADER=${CMAKE_CURRENT_BINARY_DIR}/generated/firmware_version.h
        -DOUTPUT_TEXT=${CMAKE_CURRENT_BINARY_DIR}/firmware_version.txt
        -P ${CMAKE_CURRENT_LIST_DIR}/cmake/firmware_version.cmake
    BYPRODUCTS
        ${CMAKE_CURRENT_BINARY_DIR}/generated/firmware_version.h
        ${CMAKE_CURRENT_BINARY_DIR}/firmware_version.txt
    COMMENT "Generating firmware version"
)
file(MAKE_DIRECTORY ${CMAKE_CURRENT_BINARY_DIR}/generated)

# What every firmware build has: USB stdio, the warnings, the generated
# headers, TLS and the libraries the shared sources use
function(ehymnboard_firmware_common target)
    add_dependencies(${target} ehymnboard_firmware_version)
    ehymnboard_use_tls(${target})
    pico_enable_stdio_uart(${target} 0)
    pico_enable_stdio_usb(${target} 1)
    target_compile_options(${target} PRIVATE -Wall -Wextra)
    if (WERROR)
        target_compile_options(${target} PRIVATE -Werror)
    endif()
    target_include_directories(${target} PRIVATE
            ${CMAKE_CURRENT_LIST_DIR}/src
            ${CMAKE_CURRENT_BINARY_DIR}/generated
    )
    target_link_libraries(${target}
            pico_stdlib
            pico_cyw43_arch_lwip_threadsafe_background
            pico_lwip_http
            pico_unique_id
    )
endfunction()

# The OTA image of a build: its binary with a 256-byte trailer ending in the
# binary's SHA-256, AES encrypted (cmake/ota_image.py)
function(ehymnboard_ota_image target)
    set(plain ${CMAKE_CURRENT_BINARY_DIR}/${target}_fota_image.bin)
    set(sealed ${CMAKE_CURRENT_BINARY_DIR}/${target}_fota_image_encrypted.bin)
    add_custom_command(TARGET ${target} POST_BUILD
        COMMAND ${CMAKE_OBJCOPY} -O binary $<TARGET_FILE:${target}> ${plain}
        COMMAND ${Python_EXECUTABLE} -I ${OTA_IMAGE_SCRIPT} seal --key ${EHYMNBOARD_OTA_AES_KEY} ${plain} ${sealed}
        BYPRODUCTS ${plain} ${sealed}
        COMMENT "Making ${target}'s OTA image")
endfunction()

set(FIRMWARE_SOURCES
        src/main.cpp
        src/board_link.cpp
        src/board_messages.cpp
        src/boot_control.cpp
        src/boot_flash.cpp
        src/bootloader_images.S
        src/bootloader_install.cpp
        src/fetch_image.cpp
        src/flash_write.cpp
        src/healthchecks.cpp
        src/http_headers.cpp
        src/long_watchdog.cpp
        src/malloc_lock.cpp
        src/ota.cpp
        src/ota_slots.cpp
        src/request_path.cpp
        src/saved_state.cpp
        src/state.cpp
        src/tls.cpp
        src/utils.cpp
        src/waveshare.cpp
        src/wifi.cpp
        src/ws_client.cpp
        src/ws_connection.cpp
        src/ws_frame.cpp
        src/ws_handshake.cpp
)
# The firmware carries the A/B bootloader, to install it on boards still on
# pico_fota_bootloader (src/bootloader_install.h)
set_source_files_properties(src/bootloader_images.S PROPERTIES
    COMPILE_DEFINITIONS "EHB_STUB_BIN=\"${BOOT_STUB_BIN}\";EHB_BOOTLOADER_BIN=\"${BOOTLOADER_BIN}\""
    OBJECT_DEPENDS "${BOOT_STUB_BIN};${BOOTLOADER_BIN}")

# The firmware, once for each slot: ehymnboard runs from slot A (and is what
# boards on pico_fota_bootloader install), ehymnboard_b from slot B. Each
# compiles the same sources; only the link differs.
foreach(slot a b)
    if (slot STREQUAL "a")
        set(target ehymnboard)
        set(origin ${EHB_SLOT_A_ORIGIN})
    else()
        set(target ehymnboard_b)
        set(origin ${EHB_SLOT_B_ORIGIN})
    endif()
    add_executable(${target} ${FIRMWARE_SOURCES})
    pico_set_program_name(${target} "ehymnboard")
    ehymnboard_firmware_common(${target})
    add_dependencies(${target} ehymnboard_boot_stub ehymnboard_bootloader)
    target_compile_definitions(${target} PRIVATE EHYMNBOARD_OTA_AES_KEY="${EHYMNBOARD_OTA_AES_KEY}")
    target_link_libraries(${target} hardware_spi hardware_flash hardware_watchdog)
    ehymnboard_link_at(${target} ${origin} ${EHB_SLOT_LENGTH})
    ehymnboard_ota_image(${target})
endforeach()
pico_add_extra_outputs(ehymnboard)

# The file to upload to the server: both slots' OTA images, from which the
# server gives each board the one for the slot it installs into
set(OTA_BUNDLE ${CMAKE_CURRENT_BINARY_DIR}/ehymnboard_ota_bundle.bin)
add_custom_command(OUTPUT ${OTA_BUNDLE}
    COMMAND ${Python_EXECUTABLE} -I ${OTA_IMAGE_SCRIPT} bundle
        ${CMAKE_CURRENT_BINARY_DIR}/ehymnboard_fota_image_encrypted.bin
        ${CMAKE_CURRENT_BINARY_DIR}/ehymnboard_b_fota_image_encrypted.bin ${OTA_BUNDLE}
    DEPENDS ehymnboard ehymnboard_b ${OTA_IMAGE_SCRIPT}
    COMMENT "Bundling the OTA images")
add_custom_target(ehymnboard_ota_bundle ALL DEPENDS ${OTA_BUNDLE})

# The WebSocket client as the Autobahn test suite's echo client, for the
# emulator to run against the suite's fuzzingserver (see
# emulator/autobahn/README.md). Not for real boards.
add_executable(ehymnboard_autobahn
        src/autobahn_main.cpp
        src/flash_write.cpp
        src/http_headers.cpp
        src/long_watchdog.cpp
        src/malloc_lock.cpp
        src/request_path.cpp
        src/saved_state.cpp
        src/state.cpp
        src/tls.cpp
        src/utils.cpp
        src/wifi.cpp
        src/ws_client.cpp
        src/ws_frame.cpp
        src/ws_handshake.cpp
)
ehymnboard_firmware_common(ehymnboard_autobahn)
# Linked like the real firmware in slot A, so the emulator boots it the same way
ehymnboard_link_at(ehymnboard_autobahn ${EHB_SLOT_A_ORIGIN} ${EHB_SLOT_LENGTH})
pico_add_extra_outputs(ehymnboard_autobahn)
