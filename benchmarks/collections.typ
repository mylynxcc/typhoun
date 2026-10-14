// Array and map construction, indexing, iteration and lookup.
const items = []

for i in range(0, 20000) {
    push(items, i * 2)
}

let sum = 0
for value in items {
    sum += value
}

let buckets = {}
for value in items {
    const key = str(value % 10)
    if has(buckets, key) {
        buckets[key] += 1
    } else {
        buckets[key] = 1
    }
}

print("collections sum =", sum, "buckets =", len(keys(buckets)))
