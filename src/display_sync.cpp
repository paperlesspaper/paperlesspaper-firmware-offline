#include "display_sync.h"
DisplayMutex &displayMutex() {
    static DisplayMutex mutex;
    return mutex;
}
