/*
 * Added to pico_fota_bootloader's app linker script (lib/.../app2040.ld),
 * which predates pico-sdk 2.3. The SDK's own 2.3+ scripts provide
 * __dso_handle, which libstdc++ references; PROVIDE only defines it when
 * nothing else does, so this is a no-op on older SDKs.
 */
PROVIDE(__dso_handle = 0);
