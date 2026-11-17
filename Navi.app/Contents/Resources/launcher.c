// SPDX-License-Identifier: AGPL-3.0-only
// A native LaunchServices entrypoint for the adjacent Node launcher.
#include <limits.h>
#include <mach-o/dyld.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(void) {
    char raw[PATH_MAX], resolved[PATH_MAX], script[PATH_MAX];
    uint32_t capacity = sizeof(raw);
    if (_NSGetExecutablePath(raw, &capacity) != 0 || realpath(raw, resolved) == NULL) return 78;
    char *last = strrchr(resolved, '/');
    if (last == NULL) return 78;
    *last = '\0';
    last = strrchr(resolved, '/');
    if (last == NULL) return 78;
    *last = '\0';
    const int size = snprintf(script, sizeof(script), "%s/Resources/launch.zsh", resolved);
    if (size < 0 || (size_t)size >= sizeof(script)) return 78;
    char *const argv[] = {"/bin/zsh", "-f", script, NULL};
    execv(argv[0], argv);
    return 78;
}
