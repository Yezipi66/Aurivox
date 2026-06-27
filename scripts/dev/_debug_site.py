import sys, os, site
print("sys.prefix:", sys.prefix)
print("sys.base_prefix:", sys.base_prefix)
print("sys.executable:", sys.executable)
print("site.ENABLE_USER_SITE:", site.ENABLE_USER_SITE)
print("site packages:", site.getsitepackages())
print("user site:", site.getusersitepackages())
print("sys.path:")
for p in sys.path:
    print("  ", repr(p))
# Check if usercustomize.py exists
import importlib
for p in sys.path:
    candidate = os.path.join(p, "usercustomize.py")
    if os.path.exists(candidate):
        print("Found usercustomize.py:", candidate)
    candidate2 = os.path.join(p, "sitecustomize.py")
    if os.path.exists(candidate2):
        print("Found sitecustomize.py:", candidate2)
