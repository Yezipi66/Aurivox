import sys, os
import importlib.util

spec = importlib.util.find_spec("gsv_code")
print("find_spec:", spec)

from gsv_code import utils
print("import OK!")
