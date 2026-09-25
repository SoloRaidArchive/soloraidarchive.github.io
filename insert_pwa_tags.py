from pathlib import Path
#Automatically add the PWA support tag to all files containing an apple-touch-icon link

ROOT = Path(__file__).resolve().parent
START_MARKER = "<!-- PWA install support -->"
END_MARKER = "<!-- /PWA install support -->"
PWA_LINES = (
    START_MARKER,
    '<link rel="manifest" href="/manifest.webmanifest">',
    '<meta name="theme-color" content="#3d9dff">',
    "<script>",
    'if ("serviceWorker" in navigator) {',
    '  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js"));',
    "}",
    "</script>",
    END_MARKER,
)


def inject_after_each_apple_touch_icon(text: str) -> tuple[str, int]:
    source_lines = text.splitlines(keepends=True)
    cleaned_lines = []
    inside_pwa_block = False

    for line in source_lines:
        if line.strip() == START_MARKER:
            inside_pwa_block = True
            continue
        if inside_pwa_block:
            if line.strip() == END_MARKER:
                inside_pwa_block = False
            continue
        cleaned_lines.append(line)

    output_lines = []
    injection_count = 0
    for line in cleaned_lines:
        output_lines.append(line)
        if "apple-touch-icon" not in line:
            continue

        newline = "\r\n" if line.endswith("\r\n") else "\n"
        output_lines.extend(f"{pwa_line}{newline}" for pwa_line in PWA_LINES)
        injection_count += 1

    return "".join(output_lines), injection_count


def main() -> None:
    targets = sorted(ROOT.rglob("*.html")) + [ROOT / "submission-worker.js"]
    changed_files = 0
    injection_count = 0

    for path in targets:
        with path.open("r", encoding="utf-8", newline="") as source:
            original = source.read()
        updated, file_injection_count = inject_after_each_apple_touch_icon(original)
        injection_count += file_injection_count

        if updated == original:
            continue
        with path.open("w", encoding="utf-8", newline="") as destination:
            destination.write(updated)
        changed_files += 1

    print(f"PWA tags present at {injection_count} anchor(s); {changed_files} file(s) updated.")


if __name__ == "__main__":
    main()