// Recursive Fibonacci — call dispatch, argument binding and arithmetic.
// Exercises the call path hardest of all the benchmarks.
fn fib(n) {
    if n < 2 {
        return n
    }
    return fib(n - 1) + fib(n - 2)
}

print("fib(20) =", fib(20))
