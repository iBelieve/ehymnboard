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

# Over-the-air updates: pico_fota_bootloader keeps an application slot and a
# download slot in flash and swaps them on reboot, rolling back if the new
# firmware doesn't commit itself. See README.md ("OTA updates").
#
# The OTA image is AES encrypted (it contains the WiFi passphrases from
# secrets.h and is served over plain HTTP), so builds need a key. Put it in
# secrets.cmake (see secrets.example.cmake) or pass -DPFB_AES_KEY=...
include(${CMAKE_CURRENT_LIST_DIR}/secrets.cmake OPTIONAL)
if (NOT PFB_AES_KEY)
    message(FATAL_ERROR "PFB_AES_KEY is not set: copy secrets.example.cmake to secrets.cmake and set a key")
elseif (PFB_AES_KEY STREQUAL "CHANGEME")
    message(WARNING "PFB_AES_KEY is the example key: don't install this build on a board")
endif()
set(PFB_WITH_IMAGE_ENCRYPTION ON)
set(PFB_WITH_SHA256_HASHING ON)
# The last flash sector holds SavedState (see state.cpp). 8 KB rather than 4 KB
# because the two slots must each be a multiple of 4 KB. Changing this moves
# the slots, so boards would need the bootloader reflashed over USB.
set(PFB_RESERVED_FILESYSTEM_SIZE_KB 8)
# The bootloader's image encryption script needs pycryptodome, a uv dev
# dependency: use the uv environment (`uv sync`) when there is one
if (NOT Python_EXECUTABLE AND EXISTS ${CMAKE_CURRENT_LIST_DIR}/.venv/bin/python)
    set(Python_EXECUTABLE ${CMAKE_CURRENT_LIST_DIR}/.venv/bin/python)
endif()
add_subdirectory(lib/pico_fota_bootloader)

# Add executable. Default name is the project name, version 0.1

add_executable(ehymnboard
        src/main.cpp
        src/board_link.cpp
        src/board_messages.cpp
        src/fetch_image.cpp
        src/healthchecks.cpp
        src/http_headers.cpp
        src/long_watchdog.cpp
        src/ota.cpp
        src/request_path.cpp
        src/saved_state.cpp
        src/state.cpp
        src/utils.cpp
        src/waveshare.cpp
        src/wifi.cpp
        src/ws_client.cpp
        src/ws_connection.cpp
        src/ws_frame.cpp
        src/ws_handshake.cpp
)

pico_set_program_name(ehymnboard "ehymnboard")

# Regenerate the firmware version on every build (the image and its reported
# version must always match). Also written to firmware_version.txt for
# uploading alongside the OTA image.
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
add_dependencies(ehymnboard ehymnboard_firmware_version)

# Modify the below lines to enable/disable output over UART/USB
pico_enable_stdio_uart(ehymnboard 0)
pico_enable_stdio_usb(ehymnboard 1)

target_compile_options(ehymnboard PRIVATE -Wall -Wextra)

# CI passes -DWERROR=ON; warnings are treated as errors there, so fix any
# warnings before pushing
option(WERROR "Treat compiler warnings as errors" OFF)
if (WERROR)
    target_compile_options(ehymnboard PRIVATE -Werror)
endif()

# Add the standard library to the build
target_link_libraries(ehymnboard
        pico_stdlib)

# Add the standard include files to the build
target_include_directories(ehymnboard PRIVATE
        ${CMAKE_CURRENT_LIST_DIR}/src
        ${CMAKE_CURRENT_BINARY_DIR}/generated
)

# Add any user requested libraries
target_link_libraries(ehymnboard 
        hardware_spi
        pico_cyw43_arch_lwip_threadsafe_background
        pico_lwip_http
        pico_unique_id
        pico_fota_bootloader_lib
        )

# Links the app at the application slot and produces
# ehymnboard_fota_image_encrypted.bin, the file to upload to the server
pfb_compile_with_bootloader(ehymnboard)
# Passed as an input file, so it adds to the linker script instead of
# replacing it
target_link_options(ehymnboard PRIVATE ${CMAKE_CURRENT_LIST_DIR}/cmake/app_extra.ld)
pico_add_extra_outputs(ehymnboard)

# The WebSocket client as the Autobahn test suite's echo client, for the
# emulator to run against the suite's fuzzingserver (see
# emulator/autobahn/README.md). Not for real boards.
add_executable(ehymnboard_autobahn
        src/autobahn_main.cpp
        src/http_headers.cpp
        src/long_watchdog.cpp
        src/request_path.cpp
        src/saved_state.cpp
        src/state.cpp
        src/utils.cpp
        src/wifi.cpp
        src/ws_client.cpp
        src/ws_frame.cpp
        src/ws_handshake.cpp
)
add_dependencies(ehymnboard_autobahn ehymnboard_firmware_version)
pico_enable_stdio_uart(ehymnboard_autobahn 0)
pico_enable_stdio_usb(ehymnboard_autobahn 1)
target_compile_options(ehymnboard_autobahn PRIVATE -Wall -Wextra)
if (WERROR)
    target_compile_options(ehymnboard_autobahn PRIVATE -Werror)
endif()
target_include_directories(ehymnboard_autobahn PRIVATE
        ${CMAKE_CURRENT_LIST_DIR}/src
        ${CMAKE_CURRENT_BINARY_DIR}/generated
)
target_link_libraries(ehymnboard_autobahn
        pico_stdlib
        pico_cyw43_arch_lwip_threadsafe_background
        pico_lwip_http
        pico_unique_id
        pico_fota_bootloader_lib
        )
# Linked like the real firmware, so the emulator boots it the same way
pfb_compile_with_bootloader(ehymnboard_autobahn)
target_link_options(ehymnboard_autobahn PRIVATE ${CMAKE_CURRENT_LIST_DIR}/cmake/app_extra.ld)
pico_add_extra_outputs(ehymnboard_autobahn)
