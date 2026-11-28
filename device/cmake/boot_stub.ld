/* Flash's first sector: boot2, then the stub (src/boot_stub.S) at 0x100,
   where boot2 looks for a vector table */
MEMORY
{
    FLASH(rx) : ORIGIN = 0x10000000, LENGTH = 4k
}

SECTIONS
{
    .boot2 : {
        __boot2_start__ = .;
        KEEP (*(.boot2))
        __boot2_end__ = .;
    } > FLASH

    ASSERT(__boot2_end__ - __boot2_start__ == 256,
        "ERROR: Pico second stage bootloader must be 256 bytes in size")

    .text : {
        KEEP (*(.vectors))
        *(.text*)
    } > FLASH
}
