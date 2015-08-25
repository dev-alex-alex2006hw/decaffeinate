import check from './support/check';

describe('switch', () => {
  it('works with a single case', () => {
    check(`
      switch a
        when b
          c
    `, `
      switch (a) {
        case b:
          c;
          break;
      }
    `);
  });

  it('works with multiple cases', () => {
    check(`
      switch a
        when b
          c
        when d
          e
    `, `
      switch (a) {
        case b:
          c;
          break;
        case d:
          e;
          break;
      }
    `);
  });

  it('works with multiple conditions per case', () => {
    check(`
      switch a
        when b, c
          d
    `, `
      switch (a) {
        case b: case c:
          d;
          break;
      }
    `);
  });

  it('works with cases and consequents on the same line', () => {
    check(`
      switch a
        when b then c
    `, `
      switch (a) {
        case b: c; break;
      }
    `);
  });

  it('works with a default case', () => {
    check(`
      switch a
        when b
          c
        else
          d
    `, `
      switch (a) {
        case b:
          c;
          break;
        default:
          d;
      }
    `);
  });

  it('works with a single-line default case', () => {
    check(`
      switch a
        when b then c
        else d
    `, `
      switch (a) {
        case b: c; break;
        default: d;
      }
    `);
  });

  it('works with an indented switch', () => {
    check(`
      if true
        switch a
          when b
            c
    `, `
      if (true) {
        switch (a) {
          case b:
            c;
            break;
        }
      }
    `);
  });

  it('works with implicit returns', () => {
    check(`
      ->
        switch a
          when b then c
          when d
            e
            f
          else g
    `, `
      (function() {
        switch (a) {
          case b: return c;
          case d:
            e;
            return f;
          default: return g;
        }
      });
    `);
  });

  it('works with implicit returns with the default case on another line', () => {
    check(`
      ->
        switch a
          when b then c
          else
            d
    `, `
      (function() {
        switch (a) {
          case b: return c;
          default:
            return d;
        }
      });
    `);
  });

  it('works with the switch from the CoffeeScript demo page', () => {
    check(`
    switch day
      when "Mon" then go work
      when "Tue" then go relax
      when "Thu" then go iceFishing
      when "Fri", "Sat"
        if day is bingoDay
          go bingo
          go dancing
      when "Sun" then go church
      else go work
    `, `
      switch (day) {
        case "Mon": go(work); break;
        case "Tue": go(relax); break;
        case "Thu": go(iceFishing); break;
        case "Fri": case "Sat":
          if (day === bingoDay) {
            go(bingo);
            go(dancing);
          }
          break;
        case "Sun": go(church); break;
        default: go(work);
      }
    `);
  });
});