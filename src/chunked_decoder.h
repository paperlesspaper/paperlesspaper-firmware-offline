#pragma once
#include <stddef.h>
#include <stdint.h>

// Decodes an HTTP body sent with "Transfer-Encoding: chunked" (RFC 9112, section 7.1):
//
//    <size in hex>[;extension]\r\n <size bytes of data> \r\n   ... repeated ...
//    0\r\n [trailer lines] \r\n
//
// Servers that create a picture on request (Home Assistant, PHP, Node, most proxies) answer
// this way, because they do not know the length when they start to send. The raw bytes of the
// connection are fed in as they arrive, in pieces of any size. The body goes to the sink.
//
// No Arduino dependency, so the class can also be compiled and tested on a PC.
class ChunkedDecoder
{
 public:
   // Receives decoded body bytes. Returns false if they cannot be stored.
   typedef bool (*Sink)(const uint8_t *data, uint32_t len);

   // Returns false if the input is not a valid chunked body or the sink refused data.
   bool feed(const uint8_t *data, size_t len, Sink sink) {
      size_t i = 0;
      while (i < len) {
         const uint8_t c = data[i];
         switch (state) {
         case SIZE:
            if (hexValue(c) >= 0) {
               if (digits >= 8) // would not fit into 32 bit
                  return fail();
               chunkSize = (chunkSize << 4) | (uint32_t)hexValue(c);
               digits++;
               i++;
            }
            else if (digits == 0) {
               return fail(); // a chunk must start with its size
            }
            else {
               state = SIZE_LINE_END; // look at this byte again there
            }
            break;

         case SIZE_LINE_END: // rest of the size line: optional extension, then CR LF
            i++;
            if (c == '\n') {
               if (chunkSize == 0) {
                  state = DONE; // last chunk; trailer lines are not needed
               }
               else {
                  remaining = chunkSize;
                  state = DATA;
               }
            }
            break;

         case DATA: {
            const size_t available = len - i;
            const uint32_t n = (available < remaining) ? (uint32_t)available : remaining;
            if (!sink(data + i, n))
               return fail();
            i += n;
            remaining -= n;
            if (remaining == 0)
               state = DATA_END;
            break;
         }

         case DATA_END: // CR LF behind the data of a chunk
            i++;
            if (c == '\n') {
               chunkSize = 0;
               digits = 0;
               state = SIZE;
            }
            else if (c != '\r') {
               return fail();
            }
            break;

         case DONE:
            return true; // bytes behind the last chunk are ignored

         case FAILED:
            return false;
         }
      }
      return true;
   }

   // true once the last chunk (size 0) was read: the body is complete
   bool done() const { return state == DONE; }

 private:
   enum State
   {
      SIZE,
      SIZE_LINE_END,
      DATA,
      DATA_END,
      DONE,
      FAILED
   };

   static int hexValue(uint8_t c) {
      if (c >= '0' && c <= '9')
         return c - '0';
      if (c >= 'a' && c <= 'f')
         return c - 'a' + 10;
      if (c >= 'A' && c <= 'F')
         return c - 'A' + 10;
      return -1;
   }

   bool fail() {
      state = FAILED;
      return false;
   }

   State state = SIZE;
   uint32_t chunkSize = 0;
   uint32_t remaining = 0;
   uint8_t digits = 0;
};
