SECTIONS { . = 0x81200000; .text : { *(.text.start) *(.text*) } .rodata : { *(.rodata*) *(.sdata2*) } .data : { *(.data*) *(.sdata*) *(.sbss*) *(.bss*) } /DISCARD/ : { *(.comment) *(.eh_frame*) } }
