import sys, os
path = r"D:\Project\tts_broker_openai_compat\lib\training\gsv_code"
print("Checking path:", path)
print("Is dir:", os.path.isdir(path))
print("Contents:", sorted(os.listdir(path))[:15])
init_path = os.path.join(path, "__init__.py")
print("Init exists:", os.path.exists(init_path))
with open(init_path, "r", encoding="utf-8") as fp:
    print("Init content:", repr(fp.read()[:100]))
# Check if there is a .pth file blocking
import site
print("site packages:", site.getsitepackages())
print("user site:", site.getusersitepackages())
# Try importlib.util.find_spec
import importlib.util
spec = importlib.util.find_spec("gsv_code")
print("find_spec:", spec)
