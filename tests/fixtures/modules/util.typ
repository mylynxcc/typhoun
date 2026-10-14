const GREETING = "hello from util"

fn double(n) {
    return n * 2
}

fn makeAdder(base) {
    return fn (n) {
        return base + n
    }
}
