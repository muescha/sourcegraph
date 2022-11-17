declare namespace jest {
    interface Matchers<R, T> {
        toBeAriaEnabled(): R
        toBeAriaDisabled(): R
    }
}
