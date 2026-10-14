// Function call overhead in a hot loop: every iteration performs one user
// function call with two arguments and one addition.
fn add(a, b) {
    return a + b
}

let total = 0
for _ in range(0, 100000) {
    total = add(total, 1)
}

print("calls total =", total)
