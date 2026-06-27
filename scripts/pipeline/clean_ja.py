import os, shutil

work_dir = r"D:\Project\tts_broker_openai_compat\test_raiden\日文"

# Delete old outputs
for item in ["2-name2text-0.txt", "3-bert", "4-cnhubert", "5-wav32k", "6-name2semantic.tsv", "7-sv_cn", "logs_s1", "logs_s2"]:
    path = os.path.join(work_dir, item)
    if os.path.exists(path):
        if os.path.isdir(path):
            shutil.rmtree(path)
        else:
            os.remove(path)
        print(f"Deleted: {item}")

print("Cleaned!")
