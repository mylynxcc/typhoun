// factorial.typ — recursion and a loop, side by side.
fn factorial(n) {
    if n <= 1 {
        return 1
    }
    return n * factorial(n - 1)
}

fn factorialIterative(n) {
    let result = 1
    let i = 2
    while i <= n {
        result *= i
        i += 1
    }
    return result
}

for i in range(0, 11) {
    const label = "factorial(" + str(i) + ")"
    print(label + " =", factorial(i), "(iterative:" + " " + str(factorialIterative(i)) + ")")
}

print("assertion check:", factorial(5) == factorialIterative(5))
