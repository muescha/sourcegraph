import React from "react";
import Fuze from "fuse.js";
import classNames from "classnames";
import Container from "sourcegraph/Container";
import Dispatcher from "sourcegraph/Dispatcher";
import debounce from "lodash/function/debounce";
import * as router from "sourcegraph/util/router";
import TreeStore from "sourcegraph/tree/TreeStore";
import SearchResultsStore from "sourcegraph/search/SearchResultsStore";
import "sourcegraph/tree/TreeBackend";
import * as TreeActions from "sourcegraph/tree/TreeActions";
import * as SearchActions from "sourcegraph/search/SearchActions";

const SYMBOL_LIMIT = 7;
const FILE_LIMIT = 7;

class TreeSearch extends Container {
	constructor(props) {
		super(props);
		this.state = {
			visible: false,
			loading: false,
			matchingSymbols: {Results: [], SrclibDataVersion: null},
			matchingFiles: [],
			query: "",
			selectionIndex: 0,
		};
		this._handleKeyUp = this._handleKeyUp.bind(this);
		this._focusInput = this._focusInput.bind(this);
		this._blurInput = this._blurInput.bind(this);
		this._onType = this._onType.bind(this);
		this._numResults = this._numResults.bind(this);
		this._getSelectionURL = this._getSelectionURL.bind(this);
		this._debouncedSetQuery = debounce((query) => {
			this.setState({query: query, selectionIndex: 0});
		}, 300, {leading: false, trailing: true});
	}

	componentDidMount() {
		super.componentDidMount();
		if (!this.state.overlay) {
			this._focusInput();
		} else {
			document.addEventListener("keyup", this._handleKeyUp);
		}
	}

	componentWillUnmount() {
		super.componentWillUnmount();
		if (this.state.overlay) {
			document.removeEventListener("keyup", this._handleKeyUp);
		}
	}

	stores() { return [TreeStore, SearchResultsStore]; }

	reconcileState(state, props) {
		Object.assign(state, props);
		state.matchingSymbols = SearchResultsStore.results.get(state.repo, state.rev, state.query, "tokens", 1) || {Results: [], SrclibDataVersion: null};
		console.log(state.matchingSymbols);
	}

	onStateTransition(prevState, nextState) {
		if (nextState.repo && nextState.rev) {
			let fileList = TreeStore.fileLists.get(nextState.repo, nextState.rev);
			nextState.allFiles = fileList ? fileList.Files : null;
		}

		const becameVisible = nextState.visible && nextState.visible !== prevState.visible;
		if (becameVisible || nextState.repo !== prevState.repo || nextState.rev !== prevState.rev) {
			// Don't load the file list when the page loads until we become visible.
			const initialLoad = !prevState.repo && !prevState.rev;
			if (!initialLoad || nextState.prefetch) {
				Dispatcher.asyncDispatch(new TreeActions.WantFileList(nextState.repo, nextState.rev));
				Dispatcher.asyncDispatch(
					new SearchActions.WantResults(nextState.repo, nextState.rev, "tokens", 1, SYMBOL_LIMIT, nextState.query)
				);
			}
		}

		if (nextState.allFiles !== prevState.allFiles) {
			nextState.fuzzyFinder = nextState.allFiles && new Fuze(nextState.allFiles, {
				distance: 1000,
				location: 0,
				threshold: 0.1,
			});
			nextState.loading = nextState.allFiles === null;
		}

		if (nextState.fuzzyFinder !== prevState.fuzzyFinder || nextState.query !== prevState.query) {
			nextState.matchingFiles = (nextState.query && nextState.fuzzyFinder) ? nextState.fuzzyFinder.search(nextState.query).map(i => nextState.allFiles[i]) : nextState.allFiles;
		}

		if (nextState.query !== prevState.query) {
			Dispatcher.asyncDispatch(
				new SearchActions.WantResults(nextState.repo, nextState.rev, "tokens", 1, SYMBOL_LIMIT, nextState.query)
			);
		}
	}

	_handleKeyUp(ev) {
		const tag = ev.target.tagName;
		switch (ev.keyCode) {
		case 84: // "t"
			if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
			this._focusInput();
			break;

		case 27: // ESC
			this._blurInput();
		}
	}

	_focusInput() {
		if (document.body.dataset.fileSearchDisabled) {
			return null;
		}

		this.setState({
			visible: true,
			selectionIndex: 0,
		}, () => this.refs.input && this.refs.input.focus());
	}

	_blurInput() {
		if (this.refs.input) this.refs.input.blur();

		this.setState({
			visible: false,
			loading: false,
		});
	}

	_numResults() {
		const fileResults = this.state.matchingFiles.length > FILE_LIMIT ? FILE_LIMIT : this.state.matchingFiles.length;
		const symbolResults = this.state.matchingSymbols.Results.length > SYMBOL_LIMIT ? SYMBOL_LIMIT : this.state.matchingSymbols.Results.length;
		return fileResults + symbolResults;
	}

	_getSelectionURL() {
		const i = this.state.selectionIndex;
		if (i < this.state.matchingSymbols.Results.length) {
			const def = this.state.matchingSymbols.Results[i].Def;
			return router.def(def.Repo, def.CommitID, def.UnitType, def.Unit, def.Path);
		}
		return router.tree(this.props.repo, this.props.rev, this.state.matchingFiles[i - this.state.matchingSymbols.Results.length]);
	}

	_onType(e) {
		let idx, max;
		switch (e.key) {
		case "ArrowDown":
			idx = this.state.selectionIndex;
			max = this._numResults();

			this.setState({
				selectionIndex: idx + 1 >= max ? 0 : idx + 1,
			});

			e.preventDefault();
			break;

		case "ArrowUp":
			idx = this.state.selectionIndex;
			max = this._numResults();

			this.setState({
				selectionIndex: idx < 1 ? max-1 : idx-1,
			});

			e.preventDefault();
			break;

		case "Enter":
			window.location = this._getSelectionURL();
			e.preventDefault();
			break;

		default:
			this._debouncedSetQuery(this.refs.input ? this.refs.input.value : "");
		}
	}

	_listItems() {
		if (!this.state.visible || !this.state.matchingFiles) return [];

		let list = [],
			limit = this.state.matchingFiles.length > FILE_LIMIT ? FILE_LIMIT : this.state.matchingFiles.length;

		for (let i = 0; i < limit; i++) {
			let file = this.state.matchingFiles[i],
				fileURL = router.tree(this.props.repo, this.props.rev, file);

			let ctx = classNames({
				selected: this.state.selectionIndex - this.state.matchingSymbols.Results.length === i,
			});

			list.push(
				<li className={ctx} key={fileURL}>
					<a href={fileURL}>{file}</a>
				</li>
			);
		}

		return list;
	}

	_symbolItems() {
		if (!this.state.visible || !this.state.matchingSymbols) return [];

		let list = [],
			limit = this.state.matchingSymbols.Results.length > SYMBOL_LIMIT ? SYMBOL_LIMIT : this.state.matchingSymbols.Results.length;

		for (let i = 0; i < limit; i++) {
			let result = this.state.matchingSymbols.Results[i];
			let def = result.Def,
				defURL = router.def(def.Repo, def.CommitID, def.UnitType, def.Unit, def.Path);

			let ctx = classNames({
				selected: this.state.selectionIndex === i,
			});

			list.push(
				<li className={ctx} key={defURL}>
					<div key={defURL}>
						<a href={defURL}>
							<code>{def.Kind}</code>
							<code dangerouslySetInnerHTML={result.QualifiedName}></code>
						</a>
					</div>
				</li>
			);
		}

		return list;
	}

	render() {
		let ctx = classNames({
			"tree-entry-search": true,
			"hidden": !this.state.visible,
			"loading": this.state.loading,
		});

		let searchInputClass = classNames({
			"search-input-group": true,
			"search-input-group-overlay": this.state.overlay,
		});

		return (
			<div className={ctx}>
				<div className={classNames({overlay: this.state.overlay})} onClick={this._blurInput} />
				<div className={searchInputClass}>
					<div className="tree-search-input">
						<input type="text"
							placeholder="Search this repository..."
							ref="input"
							onKeyUp={this._onType} />
						<div className="spinner"><i className="fa fa-spinner fa-spin" /></div>
					</div>
					<div className="tree-search-label">
						Symbols
					</div>
					<ul className="tree-search-symbol-list">
						{this.state.matchingSymbols.SrclibDataVersion && this._symbolItems()}
						{!this.state.matchingSymbols.SrclibDataVersion &&
							<li>
								<i>Sourcegraph is analyzing your code &mdash; results will be available soon!</i>
							</li>
						}
					</ul>
					<div className="tree-search-label">
						Files
						<button className="btn btn-default pull-right" onClick={() => {
							const location = window.location.href,
								index = location.indexOf("/.tree");
							if (index === -1) {
								window.location.href = window.location.href + "/.tree/";
							} else {
								window.location.href = window.location.href.substring(0, index) + "/.tree/";
							}
						}}>View all</button>
					</div>
					<ul className="tree-search-file-list">
						{this._listItems()}
					</ul>
				</div>
			</div>
		);
	}
}

TreeSearch.propTypes = {
	repo: React.PropTypes.string.isRequired,
	rev: React.PropTypes.string.isRequired,
	overlay: React.PropTypes.bool.isRequired,
	prefetch: React.PropTypes.bool,
};

export default TreeSearch;
