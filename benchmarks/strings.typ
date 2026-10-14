// String building, concatenation, splitting and joining.
const parts = []
for i in range(0, 4000) {
    push(parts, str(i % 97))
}

const text = join(parts, ",")
const fields = split(text, ",")

let rebuilt = ""
for field in fields {
    rebuilt += field + ";"
}

print("strings length =", len(text), "fields =", len(fields), "rebuilt =", len(rebuilt))
