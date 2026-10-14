/*
 * wc-lite: a small wc. The reference program of the wc-lite example; port/ holds a Rust port
 * that must behave exactly the same.
 *
 * Counts lines (newline characters), words (runs of bytes other than ASCII whitespace),
 * characters (UTF-8 lead bytes), bytes, and the maximum line length (characters, tabs to the
 * next multiple of 8) of each FILE, or of standard input. Every count is printed in a field of
 * 7, in that order, followed by the file name; several files get a "total" line.
 *
 * Exit status: 0 on success, 1 if a file could not be read, 2 on a usage error.
 */
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

#define VERSION "1.0.0"

enum { LINES, WORDS, CHARS, BYTES, MAXLEN, NCOUNTS };

static const char *program;

struct counts {
    long long n[NCOUNTS];
};

static void usage(FILE *out) {
    fprintf(out,
            "Usage: %s [-clmwL] [--] [FILE]...\n"
            "Print line, word, character and byte counts for each FILE, and a total line\n"
            "when there are several. With no FILE, or when FILE is -, read standard input.\n"
            "\n"
            "  -c         print the byte counts\n"
            "  -m         print the character counts (UTF-8)\n"
            "  -l         print the newline counts\n"
            "  -w         print the word counts\n"
            "  -L         print the maximum line length (tabs stop every 8 columns)\n"
            "      --help     display this help and exit\n"
            "      --version  output version information and exit\n"
            "\n"
            "Without -c, -m, -l, -w or -L, print the line, word and byte counts.\n",
            program);
}

static int usage_error(void) {
    fprintf(stderr, "Try '%s --help' for more information.\n", program);
    return 2;
}

static int is_space(unsigned char b) {
    return b == ' ' || b == '\t' || b == '\n' || b == '\v' || b == '\f' || b == '\r';
}

/* Counts one open file. Returns 0, or the errno of a failed read. */
static int count_fd(int fd, struct counts *c) {
    unsigned char buf[65536];
    long long line = 0;
    int in_word = 0;
    ssize_t got;

    memset(c, 0, sizeof *c);
    while ((got = read(fd, buf, sizeof buf)) != 0) {
        if (got < 0) {
            if (errno == EINTR)
                continue;
            return errno;
        }
        c->n[BYTES] += got;
        for (ssize_t i = 0; i < got; i++) {
            unsigned char b = buf[i];
            int lead = (b & 0xC0) != 0x80;

            if (lead)
                c->n[CHARS]++;
            if (is_space(b)) {
                in_word = 0;
            } else if (!in_word) {
                in_word = 1;
                c->n[WORDS]++;
            }
            if (b == '\n') {
                c->n[LINES]++;
                if (line > c->n[MAXLEN])
                    c->n[MAXLEN] = line;
                line = 0;
            } else if (b == '\t') {
                line = (line / 8 + 1) * 8;
            } else if (lead) {
                line++;
            }
        }
    }
    if (line > c->n[MAXLEN])
        c->n[MAXLEN] = line;
    return 0;
}

static void print_counts(const struct counts *c, const int *show, const char *name) {
    int first = 1;

    for (int k = 0; k < NCOUNTS; k++) {
        if (!show[k])
            continue;
        printf(first ? "%7lld" : " %7lld", c->n[k]);
        first = 0;
    }
    if (name != NULL)
        printf(" %s", name);
    putchar('\n');
}

/* Counts and prints one operand ("-" is standard input). Returns 0, or 1 on an error. */
static int wc_file(const char *name, const int *show, struct counts *total) {
    struct counts c;
    int stdin_operand = strcmp(name, "-") == 0;
    int fd = stdin_operand ? STDIN_FILENO : open(name, O_RDONLY);
    int err;

    if (fd < 0) {
        fprintf(stderr, "%s: %s: %s\n", program, name, strerror(errno));
        return 1;
    }
    err = count_fd(fd, &c);
    if (!stdin_operand)
        close(fd);
    if (err != 0) {
        fprintf(stderr, "%s: %s: %s\n", program, name, strerror(err));
        return 1;
    }
    print_counts(&c, show, name);
    for (int k = 0; k < NCOUNTS; k++)
        total->n[k] = k == MAXLEN ? (c.n[k] > total->n[k] ? c.n[k] : total->n[k]) : total->n[k] + c.n[k];
    return 0;
}

int main(int argc, char **argv) {
    const char *slash = strrchr(argv[0], '/');
    int show[NCOUNTS] = {0};
    const char *files[argc];
    int nfiles = 0, any = 0, options_done = 0, status = 0;
    struct counts total = {{0}};

    program = slash != NULL ? slash + 1 : argv[0];

    /* Options may come before or after the files, up to "--". */
    for (int i = 1; i < argc; i++) {
        const char *arg = argv[i];

        if (options_done || arg[0] != '-' || arg[1] == '\0') {
            files[nfiles++] = arg;
        } else if (strcmp(arg, "--") == 0) {
            options_done = 1;
        } else if (arg[1] == '-') {
            if (strcmp(arg, "--help") == 0) {
                usage(stdout);
                return 0;
            }
            if (strcmp(arg, "--version") == 0) {
                printf("wc-lite %s\n", VERSION);
                return 0;
            }
            fprintf(stderr, "%s: unrecognized option '%s'\n", program, arg);
            return usage_error();
        } else {
            for (const char *p = arg + 1; *p != '\0'; p++) {
                const char *letters = "lwmcL";
                const char *hit = strchr(letters, *p);

                if (hit == NULL) {
                    fprintf(stderr, "%s: invalid option -- '%c'\n", program, *p);
                    return usage_error();
                }
                show[hit - letters] = 1;
                any = 1;
            }
        }
    }
    if (!any)
        show[LINES] = show[WORDS] = show[BYTES] = 1;

    if (nfiles == 0) {
        struct counts c;
        int err = count_fd(STDIN_FILENO, &c);

        if (err != 0) {
            fprintf(stderr, "%s: -: %s\n", program, strerror(err));
            return 1;
        }
        print_counts(&c, show, NULL);
        return 0;
    }
    for (int i = 0; i < nfiles; i++)
        status |= wc_file(files[i], show, &total);
    if (nfiles > 1)
        print_counts(&total, show, "total");
    return status;
}
