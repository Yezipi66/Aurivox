import sys, os
print("sys.path with gsv:")
for p in sys.path:
    if "gsv" in p.lower():
        print(" ", repr(p), "-> exists:", os.path.isdir(p))
import importlib.util
spec1 = importlib.util.find_spec("gsv_code")
print("find_spec(gsv_code):", spec1)
spec2 = importlib.util.find_spec("gsv-code")
print("find_spec(gsv-code):", spec2)
