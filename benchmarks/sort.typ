// Insertion sort over a pseudo-random array: comparisons, indexing, compound
// assignment and nested loops with a short-circuit condition.
fn insertionSort(values) {
    let i = 1
    while i < len(values) {
        const current = values[i]
        let j = i - 1
        while j >= 0 and values[j] > current {
            values[j + 1] = values[j]
            j -= 1
        }
        values[j + 1] = current
        i += 1
    }
    return values
}

const data = []
let seed = 7
for _ in range(0, 700) {
    seed = (seed * 48271) % 2147483647
    push(data, seed % 1000)
}

const sorted = insertionSort(data)
print("sort first =", sorted[0], "middle =", sorted[350], "last =", sorted[699])
