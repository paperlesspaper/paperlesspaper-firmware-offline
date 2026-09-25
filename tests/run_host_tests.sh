#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
output=$(mktemp -d)
trap 'rm -rf "$output"' EXIT
c++ -std=c++17 -Wall -Wextra -Werror -fsanitize=undefined -g \
  -Itests/host -Ilib/SerialFlash -Isrc \
  tests/host/storage_test.cpp src/image_storage.cpp lib/SerialFlash/SerialFlashDirectory.cpp \
  -o "$output/storage_test"
"$output/storage_test"

# Extract unchanged production HTTP entry point; compile it against host transports.
python3 - "$output/download_function.inc" <<'PYCODE'
import pathlib, sys
source = pathlib.Path("src/main.cpp").read_text()
start = source.index("int downloadAndSaveFile(")
end = source.index("\n// https://github.com/zenmanenergy", start)
pathlib.Path(sys.argv[1]).write_text(source[start:end])
PYCODE
c++ -std=c++17 -Wall -Wextra -Werror -fsanitize=undefined -g \
  -I"$output" -Itests/host -Ilib/SerialFlash -Isrc \
  tests/host/download_test.cpp src/image_storage.cpp lib/SerialFlash/SerialFlashDirectory.cpp \
  -o "$output/download_test"
"$output/download_test"

# Reproduce the previous whitelist rejection with all other guards unchanged.
python3 - "$output/legacy_storage.cpp" <<'PYCODE'
import pathlib, sys
source = pathlib.Path("src/image_storage.cpp").read_text()
assert source.count('if (!imageName(name) && strcmp(name, "tmp.gz"))') == 1
pathlib.Path(sys.argv[1]).write_text(source.replace(
    'if (!imageName(name) && strcmp(name, "tmp.gz"))', 'if (!imageName(name))'))
PYCODE
c++ -std=c++17 -Wall -Wextra -Werror -fsanitize=undefined -g -DLEGACY_WHITELIST_TEST \
  -Itests/host -Ilib/SerialFlash -Isrc \
  tests/host/storage_test.cpp "$output/legacy_storage.cpp" lib/SerialFlash/SerialFlashDirectory.cpp \
  -o "$output/legacy_whitelist_test"
"$output/legacy_whitelist_test"

# Exercise the production transfer/refresh helper and unchanged application map.
python3 - "$output/get_color_function.inc" <<'PYCODE'
import pathlib, sys
source = pathlib.Path("src/epaper_display.cpp").read_text()
pathlib.Path(sys.argv[1]).write_text(source[source.index("uint16_t getColor("):])
PYCODE
c++ -std=c++17 -Wall -Wextra -Werror -fsanitize=undefined -g \
  -I"$output" -Isrc tests/host/display_test.cpp -o "$output/display_test"
"$output/display_test"

python3 - "$output/rotation_function.inc" <<'PYCODE'
import pathlib, sys
source = pathlib.Path("src/main.cpp").read_text()
a = source.index("void recheckAccOrient(int setOrientValue) {")
b = source.index("\nvoid checkOrientationInBackground", a)
pathlib.Path(sys.argv[1]).write_text(source[a:b])
# Guard against reintroducing hardware calls into the actual timer callback.
callback = source[a:source.index("\nvoid serviceOrientation", a)]
assert 'accInit(' not in callback and 'deinitDisplay(' not in callback
assert 'rotationRequests.request()' in callback
panel = pathlib.Path("src/epaper_display.cpp").read_text()
a = panel.index('int setImageFromFS_13inch(')
b = panel.index('\n#endif', a)
frame = panel[a:b]
assert frame.index('makeDisplayFrame') < frame.index('display.epd2.init')
assert 'frame.orientation > 0' in frame
assert 'powerSupplyDisplay(false)' in frame and 'needsHibernate = false' in frame
assert 'display.hibernate()' not in source
PYCODE
c++ -std=c++17 -Wall -Wextra -Werror -fsanitize=undefined -g -pthread \
  -I"$output" -Isrc tests/host/rotation_test.cpp src/display_sync.cpp -o "$output/rotation_test"
"$output/rotation_test"
