import { SourceType } from 'coffee-lex';

import NodePatcher from './../../../patchers/NodePatcher';
import AssignOpPatcher from './AssignOpPatcher';
import BlockPatcher from './BlockPatcher';
import ConstructorPatcher from './ConstructorPatcher';
import FunctionPatcher from './FunctionPatcher';
import IdentifierPatcher from './IdentifierPatcher';
import ProgramPatcher from './ProgramPatcher';

import type { PatcherContext } from './../../../patchers/types';

export default class ClassPatcher extends NodePatcher {
  nameAssignee: ?NodePatcher;
  superclass: ?NodePatcher;
  body: ?BlockPatcher;

  constructor(patcherContext: PatcherContext, nameAssignee: ?NodePatcher, parent: ?NodePatcher, body: ?BlockPatcher) {
    super(patcherContext);
    this.nameAssignee = nameAssignee;
    this.superclass = parent;
    this.body = body;
  }

  /**
   * Handle code within class bodies by restructuring the class to use a static
   * method instead.
   *
   * Current limitations:
   * - Doesn't deconflict the "initClass" name of the static method.
   * - Technically this changes the execution order of the class body, although
   *   it does so in a way that is unlikely to cause problems in reasonable
   *   code.
   */
  patchAsStatement() {
    // Indentation needs to happen before child patching in case we have child
    // classes or other nested indentation situations.
    if (this.needsIndent()) {
      this.indent(1, {skipFirstLine: true});
    }
    let indent = this.getIndent();

    if (this.nameAssignee) {
      this.nameAssignee.patch();
    }
    if (this.superclass) {
      this.superclass.patch();
    }
    if (this.body) {
      this.body.patch();
    }

    this.removeThenTokenIfNecessary();

    if (!this.needsInitClass()) {
      return;
    }

    let insertPoint = this.getInitClassInsertPoint();
    let nonMethodPatchers = this.getNonMethodPatchers();
    let customConstructorInfo = this.extractCustomConstructorInfo();

    let shouldUseIIFE = this.shouldUseIIFE();

    if (shouldUseIIFE) {
      // If the class declaration might introduce a variable, we need to make
      // sure that assignment happens outside the IIFE so that it can be used
      // by the outside world.
      if (this.nameAssignee instanceof IdentifierPatcher) {
        this.insert(this.outerStart, `${this.nameAssignee.node.data} = `);
      }
      this.insert(this.outerStart, `do ->\n${indent}`);
    }

    let needsTmpName = !(this.nameAssignee instanceof IdentifierPatcher);
    let classRef;
    if (needsTmpName) {
      classRef = this.claimFreeBinding('Cls');
    } else {
      classRef = this.nameAssignee.node.data;
    }

    let assignmentNames = this.generateInitClassMethod(
      nonMethodPatchers, customConstructorInfo, insertPoint);
    this.insert(this.outerEnd, `\n${indent}${classRef}.initClass()`);
    if (shouldUseIIFE) {
      this.insert(this.outerEnd, `\n${indent}return ${classRef}`);
    }

    for (let assignmentName of assignmentNames) {
      this.insert(this.outerStart, `${assignmentName} = undefined\n${indent}`);
    }
    if (needsTmpName) {
      this.insert(this.outerStart, `${classRef} = `);
    }
  }

  /**
   * For now, code in class bodies is only supported for statement classes.
   */
  patchAsExpression() {
    this.body.patch();
  }

  needsIndent() {
    return this.needsInitClass() && this.shouldUseIIFE();
  }

  needsInitClass() {
    if (!this.body) {
      return false;
    }
    if (this.body.statements.length === 0) {
      return false;
    }

    let nonMethodPatchers = this.getNonMethodPatchers();

    if (nonMethodPatchers.length === 0 && !this.needsCustomConstructor()) {
      return false;
    }
    return true;
  }

  removeThenTokenIfNecessary() {
    let searchStart;
    if (this.superclass) {
      searchStart = this.superclass.outerEnd;
    } else if (this.nameAssignee) {
      searchStart = this.nameAssignee.outerEnd;
    } else {
      searchStart = this.contentStart;
    }
    let searchEnd;
    if (this.body) {
      searchEnd = this.body.outerStart;
    } else {
      searchEnd = this.contentEnd;
    }
    let index = this.indexOfSourceTokenBetweenSourceIndicesMatching(
      searchStart,
      searchEnd,
      token => token.type === SourceType.THEN
    );
    if (index) {
      this.overwrite(searchStart, searchEnd, `\n${this.getIndent(1)}`);
    }
  }

  shouldUseIIFE() {
    let nonMethodPatchers = this.getNonMethodPatchers();
    if (this.hasAnyAssignments(nonMethodPatchers)) {
      return true;
    }
    // It's safe to use the more straightforward class init approach as long as
    // we know that a statement can be added after us and we're not in an
    // implicit return position.
    if (this.parent instanceof BlockPatcher) {
      let { statements } = this.parent;
      if (!(this.parent.parent instanceof ProgramPatcher) &&
          this === statements[statements.length - 1]) {
        return true;
      }
      return false;
    }
    return true;
  }

  getInitClassInsertPoint() {
    if (this.superclass) {
      return this.superclass.outerEnd;
    }
    if (this.nameAssignee) {
      return this.nameAssignee.outerEnd;
    }
    return this.firstToken().end;
  }

  /**
   * Find the statements in the class body that can't be converted to JS
   * methods. These will later be moved to the top of the class in a static
   * method.
   */
  getNonMethodPatchers() {
    let nonMethodPatchers = [];
    let deleteStart = this.getInitClassInsertPoint();
    for (let patcher of this.body.statements) {
      if (!this.isClassMethod(patcher)) {
        nonMethodPatchers.push({
          patcher,
          deleteStart,
        });
      }
      deleteStart = patcher.outerEnd;
    }
    return nonMethodPatchers;
  }

  isClassMethod(patcher) {
    if (patcher instanceof ConstructorPatcher) {
      return true;
    }
    if (this.isClassAssignment(patcher.node)) {
      if (patcher.expression instanceof FunctionPatcher) {
        return true;
      }
    }
    return false;
  }

  isClassAssignment(node) {
    if (node.type === 'ClassProtoAssignOp') {
      return true;
    }
    if (node.type === 'AssignOp') {
      let {assignee} = node;
      if (assignee.type === 'MemberAccessOp') {
        if (assignee.expression.type === 'This') {
          return true;
        }
        if (this.nameAssignee) {
          let className = this.nameAssignee.node.data;
          if (assignee.expression.type === 'Identifier' &&
              assignee.expression.data === className) {
            return true;
          }
        }
      }
    }
    return false;
  }

  needsCustomConstructor() {
    for (let patcher of this.body.statements) {
      if (patcher instanceof ConstructorPatcher &&
          !(patcher.expression instanceof FunctionPatcher)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Constructors in CoffeeScript can be arbitrary expressions, so if that's the
   * case, we need to save that expression so we can compute it at class init
   * time and call it from the real constructor. If this is such a case, pick a
   * name for the constructor, get the code to evaluate the constructor
   * function, and overwrite the constructor with a function that forwards to
   * that constructor function.
   */
  extractCustomConstructorInfo() {
    for (let patcher of this.body.statements) {
      if (patcher instanceof ConstructorPatcher) {
        if (!(patcher.expression instanceof FunctionPatcher)) {
          let expressionCode = this.slice(
            patcher.expression.contentStart, patcher.expression.contentEnd);
          let ctorName;
          if (this.nameAssignee instanceof IdentifierPatcher) {
            let className = this.nameAssignee.node.data;
            ctorName = this.claimFreeBinding(`create${className}`);
          } else {
            ctorName = this.claimFreeBinding('createInstance');
          }

          let bodyIndent = this.getBodyIndent();
          let indentString = this.getProgramIndentString();

          this.overwrite(
            patcher.expression.outerStart,
            patcher.expression.outerEnd,
            `->\n${bodyIndent}${indentString}return ${ctorName}.apply(this, arguments)`
          );

          return {
            ctorName,
            expressionCode,
          };
        }
      }
    }
    return null;
  }

  /**
   * Create the initClass static method by moving nodes from the class body into
   * the static method and indenting them one level.
   *
   * Also return an array of variables that were assigned so that later code can
   * declare them outside the class body to make them accessible within the
   * class.
   */
  generateInitClassMethod(nonMethodPatchers, customConstructorInfo, insertPoint) {
    let bodyIndent = this.getBodyIndent();
    let indentString = this.getProgramIndentString();
    this.insert(insertPoint, `\n${bodyIndent}@initClass: ->`);
    let assignmentNames = [];
    for (let {patcher, deleteStart} of nonMethodPatchers) {
      let assignmentName = this.getAssignmentName(patcher);
      if (assignmentName) {
        assignmentNames.push(assignmentName);
      }
      let statementCode = this.getNonMethodStatementCode(patcher, deleteStart);
      statementCode = statementCode.replace(/\n/g, `\n${indentString}`);
      this.insert(insertPoint, statementCode);
      this.remove(deleteStart, patcher.outerEnd);
    }
    if (customConstructorInfo) {
      let { ctorName, expressionCode } = customConstructorInfo;
      this.insert(
        insertPoint,
        `\n${bodyIndent}${indentString}${ctorName} = ${expressionCode}`
      );
      assignmentNames.push(ctorName);
    }

    this.insert(insertPoint, `\n${bodyIndent}${indentString}return`);
    return assignmentNames;
  }

  hasAnyAssignments(nonMethodPatchers) {
    for (let {patcher} of nonMethodPatchers) {
      if (this.getAssignmentName(patcher)) {
        return true;
      }
    }
    return false;
  }

  getBodyIndent() {
    let bodyNodeIndent = this.body.getIndent();
    // If the body is inline, generate code at one indent level up instead of
    // at the class indentation level.
    if (bodyNodeIndent === this.getIndent()) {
      return this.getIndent(1);
    } else {
      return bodyNodeIndent;
    }
  }

  /**
   * Determine the variable assigned in the given statement, if any, since any
   * assigned variables need to be declared externally so they are available
   * within the class body. Note that this is incomplete at the moment and only
   * covers the common case of a single variable being defined.
   */
  getAssignmentName(statementPatcher) {
    if (statementPatcher.node.type === 'AssignOp' &&
        statementPatcher.assignee instanceof IdentifierPatcher) {
      return statementPatcher.node.assignee.data;
    }
    if (statementPatcher instanceof ClassPatcher &&
        statementPatcher.nameAssignee instanceof IdentifierPatcher) {
      return statementPatcher.nameAssignee.node.data;
    }
    return null;
  }

  getNonMethodStatementCode(statementPatcher, deleteStart) {
    if (statementPatcher instanceof AssignOpPatcher &&
        this.isClassAssignment(statementPatcher.node)) {
      let {assignee, expression} = statementPatcher;
      let prefixCode = this.slice(deleteStart, assignee.outerStart);
      let keyCode = this.slice(assignee.outerStart, assignee.outerEnd);
      let suffixCode = this.slice(assignee.outerEnd, expression.outerEnd);

      let equalIndex = suffixCode.indexOf('=');
      let colonIndex = suffixCode.indexOf(':');
      if (equalIndex === -1 || colonIndex < equalIndex) {
        suffixCode = suffixCode.replace(/:/, ' =');
      }

      if (statementPatcher.node.type === 'ClassProtoAssignOp') {
        // a: b -> @prototype.a = b
        return `${prefixCode}@prototype.${keyCode}${suffixCode}`;
      } else {
        // @a: b -> @a = b
        return `${prefixCode}${keyCode}${suffixCode}`;
      }
    } else {
      return this.slice(deleteStart, statementPatcher.outerEnd);
    }
  }
}
