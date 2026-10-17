/*
 * dur: parse and format durations such as "1h30m". The reference library of the durations
 * example; port/ holds a Rust port that must behave exactly the same.
 */
#ifndef DUR_H
#define DUR_H

#include <stddef.h>

typedef enum {
    DUR_OK = 0,
    DUR_EMPTY,      /* "" or a lone "-" */
    DUR_BAD_NUMBER, /* a part without digits before its unit */
    DUR_BAD_UNIT,   /* digits followed by something other than d, h, m or s */
    DUR_OVERFLOW,   /* the total doesn't fit in a long long */
} dur_status;

/*
 * Parses an optional "-" and one or more parts, each digits then a unit (d = 86400 s, h = 3600 s,
 * m = 60 s, s = 1 s), in any order, without spaces: "90s", "1h30m", "-2d". Parts add up. On
 * DUR_OK, *seconds holds the total; otherwise it is left alone.
 */
dur_status dur_parse(const char *text, long long *seconds);

/*
 * Writes seconds as parts from days down to seconds, leaving out zero parts ("1h30m", "-2d",
 * "0s"), like snprintf: at most size bytes including the NUL, and returns the full length.
 */
size_t dur_format(long long seconds, char *buf, size_t size);

#endif
