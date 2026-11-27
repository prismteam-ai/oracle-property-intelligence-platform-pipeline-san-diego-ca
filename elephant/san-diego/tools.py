"""File plumbing for run.sh: split the seed list, build and unpack the ZIPs elephant-cli
reads and writes. Standard library only. It never edits a record: files are copied as bytes.

  tools.py seed-zip <seed.csv> <row-number> <out.zip>      one-row seed.csv inside a ZIP
  tools.py apns <seed.csv>                                 print the parcel ids, one per line
  tools.py prepare-input <seed-bundle.zip> <out.zip>       property_seed + unnormalized_address
  tools.py zip-dir <dir> <out.zip>                         every file of <dir>, flat
  tools.py unpack-json <in.zip> <out-dir>                  the .json entries, folders kept
  tools.py capture <prepared.zip> <out-file>               the fetched source response
"""

import csv
import io
import os
import sys
import zipfile

SEED_FILES = ("property_seed.json", "unnormalized_address.json")


def seed_rows(path):
    with open(path, newline="", encoding="utf8") as handle:
        rows = list(csv.reader(handle))
    return rows[0], rows[1:]


def write_zip(path, entries):
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in entries:
            archive.writestr(name, data)


def main(argv):
    command = argv[1]
    if command == "apns":
        header, rows = seed_rows(argv[2])
        column = header.index("parcel_id")
        print("\n".join(row[column] for row in rows))
    elif command == "seed-zip":
        header, rows = seed_rows(argv[2])
        buffer = io.StringIO()
        writer = csv.writer(buffer, lineterminator="\n")
        writer.writerow(header)
        writer.writerow(rows[int(argv[3]) - 1])
        write_zip(argv[4], [("seed.csv", buffer.getvalue())])
    elif command == "prepare-input":
        with zipfile.ZipFile(argv[2]) as bundle:
            write_zip(argv[3], [(name, bundle.read("data/" + name)) for name in SEED_FILES])
    elif command == "zip-dir":
        names = sorted(os.listdir(argv[2]))
        entries = []
        for name in names:
            with open(os.path.join(argv[2], name), "rb") as handle:
                entries.append((name, handle.read()))
        write_zip(argv[3], entries)
    elif command == "unpack-json":
        with zipfile.ZipFile(argv[2]) as archive:
            for name in archive.namelist():
                if not name.endswith(".json") or ".." in name or name.startswith("/"):
                    continue
                target = os.path.join(argv[3], *name.split("/"))
                os.makedirs(os.path.dirname(target), exist_ok=True)
                with open(target, "wb") as handle:
                    handle.write(archive.read(name))
    elif command == "capture":
        with zipfile.ZipFile(argv[2]) as archive:
            names = [n for n in archive.namelist() if n not in SEED_FILES and "/" not in n]
            if len(names) != 1:
                raise SystemExit(f"expected one captured file in {argv[2]}, found {names}")
            with open(argv[3], "wb") as handle:
                handle.write(archive.read(names[0]))
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main(sys.argv)
