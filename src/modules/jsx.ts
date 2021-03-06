import { codeToAst, jsxToAst } from "../parsing";
import traverse from "@babel/traverse";
import { buildComponent } from "./component-builder";
import { transformFromAst } from '@babel/core';
import * as path from 'path';
import { ProcessedSelection } from "../code-actions";
import template from "@babel/template";
import * as t from '@babel/types';

const defaultTemplateOptions = {
  plugins: [
    "classProperties",
    "typescript",
    "jsx"
  ],
  sourceType: "module"
}

export function isJSX(code) {
  let ast;
  try {
    ast = template.ast(code, defaultTemplateOptions);
  } catch (e) {
    try {
      ast = template.ast(`<>${code}</>`, defaultTemplateOptions);
    } catch (e2) {
      return false;
    }
  }

  return ast && ast.expression && t.isJSX(ast.expression);
}

export function isJSXExpression(code) {
  try {
    const ast = template.ast(code, defaultTemplateOptions);
    return ast && ast.expression && t.isJSX(ast.expression);
  } catch (e) {
    return false;
  }
}

export function isRangeContainedInJSXExpression(code, start, end) {
  try {
    const ast = codeToAst(code)
    const path = findContainerPath(ast, start, end)
    return path && t.isJSX(path.node) && t.isExpression(path.node);
  } catch (e) {
    return false
  }
}

function findContainerPath(ast, start, end) {
  let foundPath = null;
  const visitor = {
    exit(path) {
      if (!foundPath && pathContains(path, start, end)) {
        foundPath = path
      }
    }
  }

  traverse(ast, visitor);
  return foundPath;
}

function pathContains(path, start, end) {
  const pathStart = path.node.loc.start
  const pathEnd = path.node.loc.end
  return ((pathStart.line < start.line) || (pathStart.line === start.line && pathStart.column < start.character))
    && ((pathEnd.line > end.line) || (pathEnd.line === end.line && pathEnd.column > end.character))
}

function capitalizeFirstLetter(string) {
  return string.charAt(0).toUpperCase() + string.slice(1);
}

function produceComponentNameFrom(fullPath: any) {
  const baseName = path.basename(fullPath, path.extname(fullPath));
  return baseName.split('-').map(capitalizeFirstLetter).join('');
}

export function wrapWithComponent(fullPath, jsx): ProcessedSelection {

  const componentProperties = {
    argumentProps: new Set(),
    memberProps: new Set(),
    state: new Set(),
    componentMembers: new Set()
  };

  const visitor = {
    Identifier(path) {
      let isMember = !!path.findParent(path => path.node.type === 'MemberExpression' || path.isArrowFunctionExpression(path.node));
      if (!isMember) {
        componentProperties.argumentProps.add(path.node.name);
      }
    },
    MemberExpression(path) {
      if (!path.node.wasVisited && t.isThisExpression(path.node.object)) {
        if (path.parent.property && (path.node.property.name === 'props' || path.node.property.name === 'state')) {
          //props or state = path.node.property.name;
          if (path.node.property.name === 'props') {
            componentProperties.memberProps.add(path.parent.property.name);
          } else {
            path.node.property.name = 'props';
            componentProperties.state.add(path.parent.property.name);
          }
        } else {
          componentProperties.componentMembers.add(path.node.property.name);
          const membershipExpr = t.memberExpression(t.memberExpression(path.node.object, t.identifier('props')), t.identifier(path.node.property.name));
          (<any>membershipExpr).wasVisited = true;
          path.replaceWith(membershipExpr);
          path.skip();
        }

        path.node.wasVisited = true;
      }

    }
  }

  const ast = jsxToAst(jsx);

  traverse(ast, visitor);

  const processedJSX = transformFromAst(ast).code;
  const indexOfLastSemicolon = processedJSX.lastIndexOf(';');
  const code = processedJSX.slice(0, indexOfLastSemicolon) + processedJSX.slice(indexOfLastSemicolon + 1);
  const componentName = produceComponentNameFrom(fullPath);

  return {
    text: buildComponent(componentName, code, componentProperties),
    metadata: {
      isJSX: true,
      componentProperties,
      name: componentName
    }
  };
}

export function createComponentInstance(name, props) {
  const stateToInputProps = Array.from(props.state).map(prop => `${prop}={this.state.${prop}}`).join(' ');
  const argPropsToInputProps = Array.from(props.argumentProps).map(prop => `${prop}={${prop}}`).join(' ');
  const memberPropsToInputProps = Array.from(props.memberProps).map(prop => `${prop}={this.props.${prop}}`).join(' ');
  const componentMembersToInputProps = Array.from(props.componentMembers).map(prop => `${prop}={this.${prop}}`).join(' ');

  return `<${name}  ${stateToInputProps} ${argPropsToInputProps} ${memberPropsToInputProps} ${componentMembersToInputProps}/>`;
}

export function isStatelessComp(code) {
  const ast = template.ast(code, defaultTemplateOptions);

  return (t.isVariableDeclaration(ast) && t.isFunction(ast.declarations[0].init)) ||
    (t.isExportDeclaration(ast) && t.isFunction(ast.declaration)) ||
    t.isFunction(ast);

}

export function isStatefulComp(code) {
  const ast = template.ast(code, defaultTemplateOptions);

  const isSupportedComponent = (classPath) => {
    const supportedComponents = ['Component', 'PureComponent'];
      return ((classPath.superClass.object && 
          classPath.superClass.object.name === 'React' && 
          supportedComponents.indexOf(classPath.superClass.property.name) !== -1)  ||
          (supportedComponents.indexOf(classPath.superClass.name) !== -1));
  }

  return (
    (t.isExportNamedDeclaration(ast) && isSupportedComponent(ast.declaration)) ||
    (t.isExportDefaultDeclaration(ast) && isSupportedComponent(ast.declaration)) ||
    isSupportedComponent(ast));

}
