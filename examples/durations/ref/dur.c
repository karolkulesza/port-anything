#include "dur.h"

#include <limits.h>
#include <stdio.h>
#include <string.h>

static unsigned long long unit_seconds(char unit) {
    switch (unit) {
    case 'd': return 86400;
    case 'h': return 3600;
    case 'm': return 60;
    case 's': return 1;
    default: return 0;
    }
}

dur_status dur_parse(const char *text, long long *seconds) {
    const char *p = text;
    int negative = *p == '-';
    if (negative) p++;
    if (*p == '\0') return DUR_EMPTY;
    /* The magnitude, up to LLONG_MAX, or one more when negative (LLONG_MIN). */
    unsigned long long limit = negative ? (unsigned long long)LLONG_MAX + 1 : (unsigned long long)LLONG_MAX;
    unsigned long long total = 0;
    while (*p != '\0') {
        if (*p < '0' || *p > '9') return DUR_BAD_NUMBER;
        unsigned long long n = 0;
        int overflow = 0;
        for (; *p >= '0' && *p <= '9'; p++) {
            unsigned digit = (unsigned)(*p - '0');
            if (n > (limit - digit) / 10) overflow = 1;
            else n = n * 10 + digit;
        }
        unsigned long long unit = unit_seconds(*p);
        if (unit == 0) return DUR_BAD_UNIT;
        p++;
        if (overflow || n > (limit - total) / unit) return DUR_OVERFLOW;
        total += n * unit;
    }
    if (!negative) *seconds = (long long)total;
    else if (total == (unsigned long long)LLONG_MAX + 1) *seconds = LLONG_MIN;
    else *seconds = -(long long)total;
    return DUR_OK;
}

size_t dur_format(long long seconds, char *buf, size_t size) {
    static const struct { char unit; unsigned long long seconds; } parts[] = {
        {'d', 86400}, {'h', 3600}, {'m', 60}, {'s', 1},
    };
    char out[64];
    size_t len = 0;
    unsigned long long rest = seconds < 0 ? (unsigned long long)(-(seconds + 1)) + 1 : (unsigned long long)seconds;
    if (seconds < 0) out[len++] = '-';
    if (rest == 0) len += (size_t)sprintf(out + len, "0s");
    for (size_t i = 0; i < sizeof parts / sizeof parts[0]; i++) {
        unsigned long long n = rest / parts[i].seconds;
        rest %= parts[i].seconds;
        if (n > 0) len += (size_t)sprintf(out + len, "%llu%c", n, parts[i].unit);
    }
    return (size_t)snprintf(buf, size, "%s", out);
}
