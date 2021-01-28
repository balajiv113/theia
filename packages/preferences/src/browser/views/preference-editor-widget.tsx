/********************************************************************************
 * Copyright (C) 2020 Ericsson and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/

/* eslint-disable @typescript-eslint/no-explicit-any */
import { postConstruct, injectable, inject } from 'inversify';
import * as React from 'react';
import { AutoSizer, ScrollParams } from 'react-virtualized';
import { Disposable } from 'vscode-jsonrpc';
import {
    ReactWidget,
    PreferenceService,
    PreferenceDataProperty,
    PreferenceScope,
    CompositeTreeNode,
    SelectableTreeNode,
    PreferenceItem,
    TreeWidget,
    TreeNode,
    Iterators,
} from '@theia/core/lib/browser';
import { Message } from '@theia/core/lib/browser/widgets/widget';
import { SinglePreferenceDisplayFactory } from './components/single-preference-display-factory';
import { Preference } from '../util/preference-types';
import { PreferencesEventService } from '../util/preference-event-service';
import { PreferencesTreeProvider } from '../preference-tree-provider';

@injectable()
export class PreferencesEditorWidget extends ReactWidget {
    static readonly ID = 'settings.editor';
    static readonly LABEL = 'Settings Editor';

    protected properties: { [key: string]: PreferenceDataProperty; };
    protected currentDisplay: CompositeTreeNode;
    protected activeScope: number = PreferenceScope.User;
    protected activeURI: string = '';
    protected activeScopeIsFolder: boolean = false;
    protected scrollContainerRef: React.RefObject<HTMLDivElement> = React.createRef();
    protected hasRendered = false;
    protected _preferenceScope: Preference.SelectedScopeDetails = Preference.DEFAULT_SCOPE;
    protected rows = new Map<string, TreeWidget.NodeRow>();

    @inject(PreferencesEventService) protected readonly preferencesEventService: PreferencesEventService;
    @inject(PreferenceService) protected readonly preferenceValueRetrievalService: PreferenceService;
    @inject(PreferencesTreeProvider) protected readonly preferenceTreeProvider: PreferencesTreeProvider;
    @inject(SinglePreferenceDisplayFactory) protected readonly singlePreferenceFactory: SinglePreferenceDisplayFactory;

    @postConstruct()
    protected init(): void {
        this.onRender.push(Disposable.create(() => this.hasRendered = true));
        this.id = PreferencesEditorWidget.ID;
        this.title.label = PreferencesEditorWidget.LABEL;
        this.preferenceValueRetrievalService.onPreferenceChanged((preferenceChange): void => {
            this.update();
        });
        this.preferencesEventService.onDisplayChanged.event(didChangeTree => this.handleChangeDisplay(didChangeTree));
        this.preferencesEventService.onNavTreeSelection.event(e => this.scrollToEditorElement(e.nodeID));
        this.currentDisplay = this.preferenceTreeProvider.currentTree;
        this.properties = this.preferenceTreeProvider.propertyList;
        this.addEventListener<any>(this.node, 'ps-scroll-y', (e: Event & { target: { scrollTop: number } }) => {
            if (this.treeRef?.list && this.treeRef.list.Grid) {
                const { scrollTop } = e.target;
                this.treeRef.list.Grid.handleScrollEvent({ scrollTop });
            }
        });
        this.update();
    }

    set preferenceScope(preferenceScopeDetails: Preference.SelectedScopeDetails) {
        this._preferenceScope = preferenceScopeDetails;
        this.handleChangeScope(this._preferenceScope);
    }

    protected callAfterFirstRender(callback: Function): void {
        if (this.hasRendered) {
            callback();
        } else {
            this.onRender.push(Disposable.create(() => callback()));
        }
    }

    protected onAfterAttach(msg: Message): void {
        this.callAfterFirstRender(() => {
            super.onAfterAttach(msg);
            this.node.addEventListener('scroll', this.onScroll);
        });
    }

    protected treeRef: TreeWidget.View | null;

    protected render = (): React.ReactNode => {
        this.doUpdateRows();
        const rows = Array.from(this.rows.values());
        return (
            <div className="settings-main">
                <div ref={this.scrollContainerRef} className="settings-main-scroll-container" id="settings-main-scroll-container">
                    {rows.length > 0 ?
                        <AutoSizer>
                            {({ height, width }) => (
                                <TreeWidget.View ref={ref => this.treeRef = ref} height={height} width={width} rows={rows}
                                    handleScroll={this.handleScroll} renderNodeRow={this.renderRow} />)}
                        </AutoSizer> : this.renderNoResultMessage()}
                </div>
            </div>
        );
    };

    protected renderRow = (row: TreeWidget.NodeRow): React.ReactNode => {
        const category = row.node;

        const isCategory = category.parent?.parent === undefined;
        const categoryLevelClass = isCategory ? 'settings-section-category-title' : 'settings-section-subcategory-title';
        if (Preference.Branch.is(category)) {
            return (
                <div className={categoryLevelClass} data-id={category.id} key={`${category.id}-editor`}
                    id={`${category.id}-editor`}>{category.name}</div>
            );
        } else if (SelectableTreeNode.is(category)) {
            const preferenceNode = category;
            const values = this.preferenceValueRetrievalService.inspect<PreferenceItem>(preferenceNode.id, this.activeURI);
            const preferenceNodeWithValueInAllScopes = { ...preferenceNode, preference: { data: this.properties[preferenceNode.id], values } };
            return this.singlePreferenceFactory.render(preferenceNodeWithValueInAllScopes);
        }
    };

    protected handleScroll = (scrollParams: ScrollParams): void => {
        this.node.scrollTop = scrollParams.scrollTop;
    };

    protected doUpdateRows(): void {
        this.treeRef?.cache.clearAll();
        const rowsToUpdate: Array<[string, TreeWidget.NodeRow]> = [];
        if (this.currentDisplay) {
            const depths = new Map<CompositeTreeNode | undefined, number>();
            let index = 0;
            const iterator = Iterators.depthFirst(this.currentDisplay, (node: CompositeTreeNode) => {
                if (Preference.Branch.is(node)) {
                    return node.children.concat(node.leaves).sort((a, b) => this.sort(a.id, b.id));
                } else if (node.children) {
                    return node.children.map(child => child);
                }
            }, node => !!node.visible);
            for (const node of iterator) {
                if (TreeNode.isVisible(node)) {
                    const parentDepth = depths.get(node.parent);
                    const depth = parentDepth === undefined ? 0 : TreeNode.isVisible(node.parent) ? parentDepth + 1 : parentDepth;
                    if (CompositeTreeNode.is(node)) {
                        depths.set(node, depth);
                    }
                    rowsToUpdate.push([node.id, {
                        index: index++,
                        node,
                        depth
                    }]);
                }
            }
        }
        this.rows = new Map(rowsToUpdate);
    }

    protected handleChangeDisplay = (didGenerateNewTree: boolean): void => {
        if (didGenerateNewTree) {
            this.currentDisplay = this.preferenceTreeProvider.currentTree;
            this.properties = this.preferenceTreeProvider.propertyList;
            this.node.scrollTop = 0;
        }
        this.update();
    };

    protected onScroll = (): void => {
        const scrollContainer = this.node;
        const scrollIsTop = scrollContainer.scrollTop === 0;
        const visibleChildren: string[] = [];
        this.addFirstVisibleChildId(scrollContainer, visibleChildren);
        if (visibleChildren.length) {
            this.preferencesEventService.onEditorScroll.fire({
                firstVisibleChildId: visibleChildren[0],
                isTop: scrollIsTop
            });
        }
    };

    protected addFirstVisibleChildId(container: HTMLElement, array: string[]): void {
        const grid = container.getElementsByClassName('ReactVirtualized__Grid__innerScrollContainer')[0];
        if (grid) {
            for (let i = 0; i < grid.children.length && !array.length; i++) {
                const listElement = grid.children[i];
                if (this.isInView(listElement as HTMLElement, this.node)) {
                    const id = listElement.children[0]?.getAttribute('data-id');
                    if (id) {
                        array.push(id);
                    }
                }
            }
        }
    }

    protected isInView(e: HTMLElement, parent: HTMLElement): boolean {
        const scrollTop = this.node.scrollTop;
        const scrollCheckHeight = 0.7;
        return this.compare(e.offsetTop).isBetween(scrollTop, scrollTop + parent.offsetHeight) ||
            this.compare(scrollTop).isBetween(e.offsetTop, e.offsetTop + (e.offsetHeight * scrollCheckHeight));
    }

    protected compare = (value: number): { isBetween: (a: number, b: number) => boolean; } => ({
        isBetween: (a: number, b: number): boolean => (
            (value >= a && value <= b) || (value >= b && value <= a)
        )
    });

    protected handleChangeScope = ({ scope, uri, activeScopeIsFolder }: Preference.SelectedScopeDetails): void => {
        this.activeScope = Number(scope);
        this.activeURI = uri;
        this.activeScopeIsFolder = activeScopeIsFolder === 'true';
        this.update();
    };

    protected renderCategory(category: Preference.Branch): React.ReactNode {
        const children = category.children.concat(category.leaves).sort((a, b) => this.sort(a.id, b.id));
        const isCategory = category.parent?.parent === undefined;
        const categoryLevelClass = isCategory ? 'settings-section-category-title' : 'settings-section-subcategory-title';
        return category.visible && (
            <ul
                className="settings-section"
                key={`${category.id}-editor`}
                id={`${category.id}-editor`}
            >
                <li className={categoryLevelClass} data-id={category.id}>{category.name}</li>
                {children.map((preferenceNode: SelectableTreeNode | Preference.Branch) => {
                    if (Preference.Branch.is(preferenceNode)) {
                        return this.renderCategory(preferenceNode);
                    }
                    const values = this.preferenceValueRetrievalService.inspect<PreferenceItem>(preferenceNode.id, this.activeURI);
                    const preferenceNodeWithValueInAllScopes = { ...preferenceNode, preference: { data: this.properties[preferenceNode.id], values } };
                    return this.singlePreferenceFactory.render(preferenceNodeWithValueInAllScopes);
                })}
            </ul>
        );
    }

    protected renderNoResultMessage(): React.ReactNode {
        return <div className="settings-no-results-announcement">That search query has returned no results.</div>;
    }

    protected scrollToEditorElement(nodeID: string): void {
        if (nodeID) {
            const el = document.getElementById(`${nodeID}-editor`);
            if (el) {
                setTimeout(() => el.scrollIntoView());
            } else {
                const treeNode = this.rows.get(nodeID);
                if (treeNode) {
                    setTimeout(() => {
                        this.treeRef?.list?.scrollToRow(treeNode.index);
                        const elAfterScroll = document.getElementById(`${nodeID}-editor`);
                        if (elAfterScroll) {
                            elAfterScroll.scrollIntoView();
                        }
                    });
                }
            }
        }
    }

    /**
     * Sort two strings.
     *
     * @param a the first string.
     * @param b the second string.
     */
    protected sort(a: string, b: string): number {
        return a.localeCompare(b, undefined, { ignorePunctuation: true });
    }
}
