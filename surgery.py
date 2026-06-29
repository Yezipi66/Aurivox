
import os

file_path = 'server.js'
with open(file_path, 'r', encoding='utf-8') as f:
    lines = f.readlines()

# Find the start of /v1/audio/speech handler
start_handler = -1
for i, line in enumerate(lines):
    if 'app.post("/v1/audio/speech"' in line:
        start_handler = i
        break

if start_handler == -1:
    print("Handler not found")
    exit(1)

# Find the try block within this handler
try_start = -1
for i in range(start_handler, len(lines)):
    if lines[i].strip() == '  try {':
        try_start = i
        break

# Find the matching catch block end
# This is tricky. I'll look for the last '}' before the next handler or end of file.
# Actually, I know it's the one ending with res.status(500).json({ error: clientError(err) });
catch_end = -1
for i in range(try_start, len(lines)):
    if 'res.status(500).json({ error: clientError(err) });' in lines[i]:
        # The block ends at the next '}'
        for j in range(i, len(lines)):
            if lines[j].strip() == '  }':
                catch_end = j
                break
        break

if try_start == -1 or catch_end == -1:
    print(f"Blocks not found. try_start: {try_start}, catch_end: {catch_end}")
    exit(1)

# Extract inner try block content
# The block starts at try_start + 1 and ends where the catch starts.
# Find where the catch starts.
catch_start = -1
for i in range(try_start, catch_end):
    if lines[i].strip() == '} catch (err) {':
        catch_start = i
        break

inner_lines = lines[try_start + 1 : catch_start]
indented_inner = ["    " + line for line in inner_lines]

# Construct the new block
new_block = [
    "  try {\n",
    "    await withGenerationLock(async () => {\n",
    *indented_inner,
    "    });\n",
    "  } catch (err) {\n",
    "    console.error(\"[ERROR] /v1/audio/speech failed:\", err.message);\n",
    "    res.status(500).json({ error: clientError(err) });\n",
    "  }\n"
]

# Replace in original lines
lines[try_start : catch_end + 1] = new_block

with open(file_path, 'w', encoding='utf-8') as f:
    f.writelines(lines)

print("Successfully wrapped /v1/audio/speech")
