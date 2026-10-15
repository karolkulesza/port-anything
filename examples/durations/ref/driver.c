/*
 * dur-driver: a command-line driver for the dur library, so Port Anything can compare it with its
 * port. Reads one call per line on stdin and prints one JSON result per line:
 *
 *   {"fn":"parse","args":["1h30m"]}  ->  {"ok":5400}
 *   {"fn":"format","args":[5400]}    ->  {"ok":"1h30m"}
 *   {"fn":"parse","args":["1x"]}     ->  {"error":"bad-unit"}
 *
 * A line that isn't a call it knows, in exactly this compact form, gives {"error":"bad-call"}.
 * Strings may hold printable ASCII and the escapes \" and \\. A real driver would use a JSON
 * library; this one has none, so the example builds with nothing but a C compiler.
 */
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "dur.h"

/* What a call's one argument is. */
enum arg_kind { ARG_STRING, ARG_INT };

struct call {
    char fn[16];
    enum arg_kind kind;
    char text[4096]; /* ARG_STRING, unescaped */
    long long n;     /* ARG_INT */
};

static int expect(const char **p, const char *literal) {
    size_t len = strlen(literal);
    if (strncmp(*p, literal, len) != 0) return 0;
    *p += len;
    return 1;
}

/* Reads one call; 0 for anything else. */
static int read_call(const char *p, struct call *call) {
    if (!expect(&p, "{\"fn\":\"")) return 0;
    size_t len = 0;
    for (; *p >= 'a' && *p <= 'z'; p++) {
        if (len + 1 >= sizeof call->fn) return 0;
        call->fn[len++] = *p;
    }
    call->fn[len] = '\0';
    if (len == 0 || !expect(&p, "\",\"args\":[")) return 0;
    if (*p == '"') {
        call->kind = ARG_STRING;
        len = 0;
        for (p++; *p != '"'; p++) {
            if (*p == '\\') {
                p++;
                if (*p != '"' && *p != '\\') return 0;
            } else if ((unsigned char)*p < 0x20 || (unsigned char)*p > 0x7e) {
                return 0;
            }
            if (len + 1 >= sizeof call->text) return 0;
            call->text[len++] = *p;
        }
        call->text[len] = '\0';
        p++;
    } else {
        call->kind = ARG_INT;
        const char *start = p;
        if (*p == '-') p++;
        if (*p < '0' || *p > '9') return 0;
        while (*p >= '0' && *p <= '9') p++;
        errno = 0;
        call->n = strtoll(start, NULL, 10);
        if (errno == ERANGE) return 0;
    }
    return expect(&p, "]}") && *p == '\0';
}

static const char *status_name(dur_status status) {
    switch (status) {
    case DUR_EMPTY: return "empty";
    case DUR_BAD_NUMBER: return "bad-number";
    case DUR_BAD_UNIT: return "bad-unit";
    case DUR_OVERFLOW: return "overflow";
    default: return "ok";
    }
}

int main(void) {
    char *line = NULL;
    size_t cap = 0;
    ssize_t len;
    struct call call;
    while ((len = getline(&line, &cap, stdin)) != -1) {
        if (len > 0 && line[len - 1] == '\n') line[--len] = '\0';
        /* A NUL byte would end the line early. */
        if (strlen(line) != (size_t)len || !read_call(line, &call)) {
            puts("{\"error\":\"bad-call\"}");
        } else if (strcmp(call.fn, "parse") == 0 && call.kind == ARG_STRING) {
            long long seconds;
            dur_status status = dur_parse(call.text, &seconds);
            if (status == DUR_OK) printf("{\"ok\":%lld}\n", seconds);
            else printf("{\"error\":\"%s\"}\n", status_name(status));
        } else if (strcmp(call.fn, "format") == 0 && call.kind == ARG_INT) {
            char text[64];
            dur_format(call.n, text, sizeof text);
            printf("{\"ok\":\"%s\"}\n", text);
        } else {
            puts("{\"error\":\"bad-call\"}");
        }
    }
    free(line);
    return 0;
}
