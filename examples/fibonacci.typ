// fibonacci.typ — two algorithms for the same sequence.
fn fibRecursive(n) {
    if n < 2 {
        return n
    }
    return fibRecursive(n - 1) + fibRecursive(n - 2)
}

fn fibIterative(n) {
    let a = 0
    let b = 1
    let i = 0
    while i < n {
        const next = a + b
        a = b
        b = next
        i += 1
    }
    return a
}

const series = []
for i in range(0, 12) {
    push(series, fibRecursive(i))
}
print("recursive:", series)
print("iterative:", fibIterative(11))
print("f(40) iteratively is", fibIterative(40))
