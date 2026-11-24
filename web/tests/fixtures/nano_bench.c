/*
 * Test program for the emulated Nano (tests/sim.test.mjs). Plain avr-libc, no Arduino core, so it builds with
 * just avr-gcc:
 *   avr-gcc -mmcu=atmega328p -DF_CPU=16000000UL -Os -o nano_bench.elf nano_bench.c
 *   avr-objcopy -O ihex -R .eeprom nano_bench.elf nano_bench.hex
 * Pins match the builder's plan for Nano + button + LED + servo + light sensor:
 * button D2, LED D3, servo D4, light sensor A0.
 */
#include <avr/io.h>
#include <util/delay.h>
#include <stdio.h>

static int uart_put(char c, FILE *f) {
  (void)f;
  while (!(UCSR0A & (1 << UDRE0))) {}
  UDR0 = c;
  return 0;
}
static FILE out = FDEV_SETUP_STREAM(uart_put, NULL, _FDEV_SETUP_WRITE);

static uint16_t adc_read(uint8_t ch) {
  ADMUX = (1 << REFS0) | (ch & 7);
  ADCSRA |= (1 << ADSC);
  while (ADCSRA & (1 << ADSC)) {}
  return ADC;
}

int main(void) {
  UCSR0A = (1 << U2X0);
  UBRR0 = 16; /* 115200 baud at 16 MHz */
  UCSR0B = (1 << TXEN0);
  stdout = &out;
  ADCSRA = (1 << ADEN) | 7;

  DDRD |= (1 << PD3) | (1 << PD4); /* LED, servo */
  PORTD |= (1 << PD2);             /* button pull-up */
  printf("Ready.\n");

  uint8_t n = 0;
  for (;;) {
    /* LED on while the button pulls D2 low */
    if (!(PIND & (1 << PD2))) PORTD |= (1 << PD3); else PORTD &= ~(1 << PD3);
    /* one servo pulse every 20 ms: 1950 us while pressed (about 136 degrees), 1000 us otherwise (about 44) */
    PORTD |= (1 << PD4);
    if (!(PIND & (1 << PD2))) _delay_us(1950); else _delay_us(1000);
    PORTD &= ~(1 << PD4);
    _delay_ms(18);
    if (++n >= 10) {
      n = 0;
      printf("light %u\n", adc_read(0));
    }
  }
}
