# Host-side unit and property tests for the firmware's hardware-independent
# code. Builds with the host compiler, not the Pico toolchain:
#
#   cmake -S test -B build-test -G Ninja && ninja -C build-test && ctest --test-dir build-test
#
# ASan and UBSan are on by default; -DCOVERAGE=ON adds gcov instrumentation
# for gcovr (see .github/workflows/ci-device.yml).

cmake_minimum_required(VERSION 3.16)

project(ehymnboard_host_tests CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

option(SANITIZE "Build with AddressSanitizer and UndefinedBehaviorSanitizer" ON)
option(COVERAGE "Build with gcov coverage instrumentation" OFF)

include(FetchContent)

FetchContent_Declare(
    googletest
    GIT_REPOSITORY https://github.com/google/googletest.git
    GIT_TAG v1.17.0
    GIT_SHALLOW TRUE
)
set(INSTALL_GTEST OFF CACHE BOOL "" FORCE)

# RapidCheck has no releases; pin a commit.
FetchContent_Declare(
    rapidcheck
    GIT_REPOSITORY https://github.com/emil-e/rapidcheck.git
    GIT_TAG 2c3c4365aca21ef4e612768fdc95b1ce8b39a651
)
set(RC_ENABLE_GTEST ON CACHE BOOL "" FORCE)

FetchContent_MakeAvailable(googletest rapidcheck)

set(FIRMWARE_SRC ${CMAKE_CURRENT_LIST_DIR}/../src)

add_executable(host_tests
    test_http_headers.cpp
    test_request_path.cpp
    test_saved_state.cpp
    ${FIRMWARE_SRC}/http_headers.cpp
    ${FIRMWARE_SRC}/request_path.cpp
    ${FIRMWARE_SRC}/saved_state.cpp
)

# stubs/ stands in for the few pico-sdk headers the code under test includes.
target_include_directories(host_tests PRIVATE stubs ${FIRMWARE_SRC})
target_compile_options(host_tests PRIVATE -Wall -Wextra -Werror)
target_link_libraries(host_tests PRIVATE GTest::gtest_main rapidcheck rapidcheck_gtest)

if (SANITIZE)
    target_compile_options(host_tests PRIVATE -fsanitize=address,undefined -fno-sanitize-recover=all -fno-omit-frame-pointer)
    target_link_options(host_tests PRIVATE -fsanitize=address,undefined)
endif()

if (COVERAGE)
    target_compile_options(host_tests PRIVATE --coverage -O0)
    target_link_options(host_tests PRIVATE --coverage)
endif()

enable_testing()
include(GoogleTest)
gtest_discover_tests(host_tests)
