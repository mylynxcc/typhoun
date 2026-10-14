// error-handling.typ — recovering from a failure instead of stopping.
//
// A runtime error in Typhoun is an ordinary value. `try { ... } catch err { ... }`
// runs the handler when something inside the guarded block fails, and hands it
// the error as a map with everything a diagnostic would carry:
//
//   {
//     "code": "TYP4005",
//     "message": "Index 4 is out of bounds for length 3",
//     "phase": "runtime",
//     "location": { "file": "…", "line": 12, "column": 7 },
//     "help": "Valid indices are 0 through 2.",
//     "stack": ["toNumber (…:3:17)", …]
//   }

print("== 1. a failure the program raises itself ==")

fn share(total, people) {
    assert(people > 0, "cannot split " + str(total) + " between " + str(people) + " people")
    return total / people
}

try {
    print("between 3:", share(12, 3))
    print("between 0:", share(12, 0))
    print("this line is never reached")
} catch err {
    print("caught", err.code + ":", err.message)
    print("raised at line", err.location.line)
}

print("")
print("== 2. a failure the runtime detects ==")

const readings = [4, 8, 15]
try {
    print("reading 4:", readings[4])
} catch err {
    print("caught", err.code + ":", err.message)
    print("help:", err.help)
}

print("")
print("== 3. the handler decides what to do, and the loop carries on ==")

fn double(row) {
    return row.amount * 2
}

const rows = [{ "amount": 4 }, { "amount": null }, { "amount": 9 }]
for row in rows {
    try {
        print("doubled:", double(row))
    } catch err {
        print("skipped a row:", err.code)
    }
}

print("")
print("== 4. a handler can fail too, and an outer handler catches that ==")

try {
    try {
        assert(false, "the inner failure")
    } catch inner {
        print("inner caught", inner.code + ":", inner.message)
        assert(false, "the inner failure")
    }
} catch outer {
    print("outer caught", outer.code + ":", outer.message)
}

print("")
print("== 5. where it happened: the call stack, innermost first ==")

fn toNumber(raw) {
    return num(raw)
}

fn sum(values) {
    let total = 0
    for value in values {
        total += toNumber(value)
    }
    return total
}

try {
    print("sum:", sum(["1", "2", "three"]))
} catch err {
    print(len(err.stack), "frame(s)")
    for frame in err.stack {
        print(" -", frame)
    }
}

print("")
print("== 6. what a handler cannot swallow ==")
// `return`, `break` and `continue` pass straight out of a `try`, and the
// sandbox's limits (TYP6xxx) never reach a handler, so a program cannot spend
// its way past the step, depth, time or output budget.
print("done")
