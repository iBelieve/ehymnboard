/*
 * The A/B bootloader's two parts, for bootloader_install.cpp to write: flash's
 * first sector (boot2 and the stub) and the bootloader. CMake passes their
 * paths as EHB_STUB_BIN and EHB_BOOTLOADER_BIN.
 */
    .section .rodata.ehb_bootloader_images, "a"
    .balign 4
    .global ehb_stub_image, ehb_stub_image_end, ehb_bootloader_image, ehb_bootloader_image_end
ehb_stub_image:
    .incbin EHB_STUB_BIN
ehb_stub_image_end:
    .balign 4
ehb_bootloader_image:
    .incbin EHB_BOOTLOADER_BIN
ehb_bootloader_image_end:
